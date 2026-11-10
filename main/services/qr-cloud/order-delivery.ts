import { acknowledgeConnectorOrder, QrCloudClientError } from './client';
import { readConfig, readConnectorSetting, type QrCloudConfig } from './config';
import { openInbox } from './inbox';
import { acceptCloudOrder, CloudOrderError } from './order-acceptance';
import { readApprovedCa } from './tls';

function nextAttempt(attempts: number) {
  return Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6));
}

export function cloudReceiptSummary(cloudUrl: string) {
  try {
    return openInbox()
      .prepare(`SELECT
      COUNT(CASE WHEN acknowledged_at IS NULL THEN 1 END) AS pending,
      COUNT(CASE WHEN acknowledged_at IS NULL AND last_error IS NOT NULL THEN 1 END) AS retrying,
      COUNT(CASE WHEN acknowledged_at IS NOT NULL THEN 1 END) AS acknowledged
      FROM order_ack_jobs WHERE cloud_url = ?`)
      .get(cloudUrl) as { pending: number; retrying: number; acknowledged: number };
  } catch {
    return null;
  }
}

export async function processCloudOrderDelivery(config: QrCloudConfig, signal: AbortSignal) {
  const db = openInbox();
  if (config.automaticSince) {
    const jobs = db
      .prepare(`
      SELECT a.event_id, a.attempts FROM order_auto_jobs a JOIN inbox_events e ON e.event_id = a.event_id
      WHERE a.cloud_url = ? AND a.automatic_since = ? AND a.retry_at <= ? AND e.status = 'received'
      ORDER BY a.retry_at, e.received_at, a.event_id LIMIT 3
    `)
      .all(config.cloudUrl, config.automaticSince, Date.now()) as {
      event_id: string;
      attempts: number;
    }[];
    for (const job of jobs) {
      if (signal.aborted) return;
      try {
        await acceptCloudOrder(undefined, job.event_id, 'cloud-automatic', undefined, {
          since: config.automaticSince,
          cloudUrl: config.cloudUrl,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        const code =
          error instanceof CloudOrderError || error instanceof QrCloudClientError
            ? error.code
            : 'pos_retry_required';
        const retry =
          job.attempts + 1 < config.retryMax &&
          (!(error instanceof CloudOrderError) || error.code === 'pos_retry_required');
        db.transaction(() => {
          db.prepare(
            "UPDATE inbox_events SET last_error = ? WHERE event_id = ? AND status = 'received'",
          ).run(code, job.event_id);
          if (retry)
            db.prepare(
              'UPDATE order_auto_jobs SET attempts = attempts + 1, retry_at = ? WHERE event_id = ?',
            ).run(nextAttempt(job.attempts), job.event_id);
          else db.prepare('DELETE FROM order_auto_jobs WHERE event_id = ?').run(job.event_id);
        })();
      }
    }
  }

  const receipts = db
    .prepare(`
    SELECT j.event_id, j.cloud_order_id, j.pos_receipt_id, a.pos_order_number, j.attempts
    FROM order_ack_jobs j JOIN order_acceptances a ON a.event_id = j.event_id
    WHERE j.cloud_url = ? AND j.acknowledged_at IS NULL AND j.retry_at <= ?
    ORDER BY j.retry_at, a.accepted_at, j.event_id LIMIT 5
  `)
    .all(config.cloudUrl, Date.now()) as {
    event_id: string;
    cloud_order_id: string;
    pos_receipt_id: string;
    pos_order_number: string;
    attempts: number;
  }[];
  for (const { attempts, ...receipt } of receipts) {
    if (signal.aborted || readConfig().cloudUrl !== config.cloudUrl) return;
    try {
      const response = (await acknowledgeConnectorOrder(
        {
          config,
          token: readConnectorSetting(),
          caPem: readApprovedCa()?.pem,
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        },
        receipt,
      )) as { ok?: boolean; pos_receipt_id?: string } | null;
      if (response?.ok !== true || response.pos_receipt_id !== receipt.pos_receipt_id) {
        throw new QrCloudClientError('bad_response');
      }
      db.prepare(
        "UPDATE order_ack_jobs SET acknowledged_at = datetime('now'), last_error = NULL WHERE event_id = ?",
      ).run(receipt.event_id);
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof QrCloudClientError ? error.code : 'ack_failed';
      db.prepare(
        'UPDATE order_ack_jobs SET attempts = attempts + 1, retry_at = ?, last_error = ? WHERE event_id = ?',
      ).run(nextAttempt(attempts), code, receipt.event_id);
    }
  }
}
