import { getDatabase } from '../../db';
import { tableAwaitingBillPayment } from '../../lib/guest-order';
import { isTerminalItemStatus } from '../../../shared/order-item-status';
import {
  acknowledgeConnectorOrder,
  syncConnectorTableStates,
  QrCloudClientError,
  reportConnectorKitchenStatus,
} from './client';
import { readConfig, readConnectorSetting, type QrCloudConfig } from './config';
import { openInbox } from './inbox';
import { acceptCloudOrder, CloudOrderError } from './order-acceptance';
import { readApprovedCa } from './tls';

const STATUS_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The guest-facing stage of a POS order item; a row no longer on the bill counts as cancelled. */
export function kitchenStatusOf(status: string | undefined): string {
  if (!status || isTerminalItemStatus(status)) return 'cancelled';
  if (status === 'served' || status === 'completed') return 'served';
  return status === 'preparing' || status === 'ready' ? status : 'pending';
}

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

  // Kitchen progress is informational for guests; it must never fail order delivery.
  await syncKitchenStatus(config, signal).catch(() => undefined);
  await syncTableStates(config, signal).catch(() => undefined);
}

async function syncTableStates(config: QrCloudConfig, signal: AbortSignal) {
  const pos = getDatabase();
  const tables = pos.prepare('SELECT id, number, is_active FROM tables ORDER BY id').all() as {
    id: string;
    number: string;
    is_active: number;
  }[];
  for (let offset = 0; offset < tables.length; offset += 250) {
    if (signal.aborted || readConfig().cloudUrl !== config.cloudUrl) return;
    await syncConnectorTableStates(
      { config, token: readConnectorSetting(), caPem: readApprovedCa()?.pem, signal },
      tables.slice(offset, offset + 250).map((table) => ({
        pos_table_id: table.id,
        name: table.number,
        active: Boolean(table.is_active),
        awaiting_payment: tableAwaitingBillPayment(pos, table.id),
      })),
    );
  }
}

async function syncKitchenStatus(config: QrCloudConfig, signal: AbortSignal) {
  const db = openInbox();
  const rows = db
    .prepare(`
    SELECT s.event_id, s.cloud_order_id, s.pos_item_ids, s.last_payload, s.attempts, s.created_at
    FROM order_status_sync s JOIN order_ack_jobs j ON j.event_id = s.event_id
    WHERE s.cloud_url = ? AND s.done = 0 AND s.retry_at <= ? AND j.acknowledged_at IS NOT NULL
    ORDER BY s.retry_at, s.created_at LIMIT 10
  `)
    .all(config.cloudUrl, Date.now()) as {
    event_id: string;
    cloud_order_id: string;
    pos_item_ids: string;
    last_payload: string | null;
    attempts: number;
    created_at: string;
  }[];
  const pos = getDatabase();
  for (const row of rows) {
    if (signal.aborted || readConfig().cloudUrl !== config.cloudUrl) return;
    const ids = JSON.parse(row.pos_item_ids) as number[];
    const current = new Map(
      (
        pos
          .prepare(
            `SELECT id, status FROM order_items WHERE id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids) as { id: number; status: string }[]
      ).map((item) => [item.id, item.status]),
    );
    const statuses = ids.map((id) => kitchenStatusOf(current.get(id)));
    const payload = JSON.stringify(statuses);
    const finished = statuses.every((status) => status === 'served' || status === 'cancelled');
    const expired =
      Date.now() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`) > STATUS_SYNC_WINDOW_MS;
    if (payload === row.last_payload) {
      if (finished || expired)
        db.prepare('UPDATE order_status_sync SET done = 1 WHERE event_id = ?').run(row.event_id);
      continue;
    }
    try {
      const response = (await reportConnectorKitchenStatus(
        {
          config,
          token: readConnectorSetting(),
          caPem: readApprovedCa()?.pem,
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        },
        { order_id: row.cloud_order_id, statuses },
      )) as { ok?: boolean } | null;
      if (response?.ok !== true) throw new QrCloudClientError('bad_response');
      db.prepare(
        'UPDATE order_status_sync SET last_payload = ?, done = ?, attempts = 0, retry_at = 0, last_error = NULL WHERE event_id = ?',
      ).run(payload, finished || expired ? 1 : 0, row.event_id);
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof QrCloudClientError ? error.code : 'status_sync_failed';
      db.prepare(
        'UPDATE order_status_sync SET attempts = attempts + 1, retry_at = ?, last_error = ?, done = ? WHERE event_id = ?',
      ).run(nextAttempt(row.attempts), code, expired ? 1 : 0, row.event_id);
    }
  }
}
