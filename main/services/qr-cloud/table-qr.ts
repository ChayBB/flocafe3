import * as QRCode from 'qrcode';
import { getDatabase } from '../../db';
import { tableAwaitingBillPayment } from '../../lib/guest-order';
import { readConfig, readConnectorSetting } from './config';
import { CONNECTOR_EVENT_ID, manageConnectorTableQr } from './client';
import { openInbox } from './inbox';
import { CloudOrderError } from './order-acceptance';
import { readApprovedCa } from './tls';

export interface CloudTableQrTable {
  id: string;
  number: string;
  status: string | null;
}

export interface CloudTableQr {
  data_url: string;
  url: string;
  expires_at: string;
}

type Action = 'open' | 'close';

/** Whether table QR codes may be opened (or, for `close`, closed) on the cloud ordering page. */
export function cloudTableQrActive(action: Action = 'open'): boolean {
  const config = readConfig();
  return (
    config.mode === 'integrated' && !config.cutoverPending && (action === 'close' || config.enabled)
  );
}

function signalFor(timeoutMs: number, requestSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline;
}

/** Opens the table's QR on the cloud ordering page and returns its link and QR image. */
export async function openCloudTableQr(
  table: CloudTableQrTable,
  requestSignal?: AbortSignal,
): Promise<CloudTableQr> {
  const config = readConfig();
  const result = (await manageConnectorTableQr(
    {
      config,
      token: readConnectorSetting(),
      caPem: readApprovedCa()?.pem,
      signal: signalFor(config.timeoutMs, requestSignal),
    },
    {
      action: 'open',
      pos_table_id: table.id,
      name: table.number,
      awaiting_payment: tableAwaitingBillPayment(getDatabase(), table.id),
    },
  )) as { url?: unknown; expires_at?: unknown } | null;
  const url = typeof result?.url === 'string' ? URL.parse(result.url) : null;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    !url.hash.startsWith('#table=') ||
    !CONNECTOR_EVENT_ID.test(url.hash.slice(7)) ||
    typeof result?.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(result.expires_at))
  ) {
    throw new CloudOrderError('invalid_cloud_table_qr', 502);
  }
  const data_url = await QRCode.toDataURL(url.href, {
    width: 360,
    margin: 4,
    errorCorrectionLevel: 'M',
  });
  openInbox()
    .prepare(
      `INSERT INTO open_table_qr (cloud_url, pos_table_id, name, seen_occupied)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (cloud_url, pos_table_id) DO UPDATE SET name = excluded.name,
         seen_occupied = MAX(open_table_qr.seen_occupied, excluded.seen_occupied), retry_at = 0`,
    )
    .run(config.cloudUrl, table.id, table.number, table.status === 'occupied' ? 1 : 0);
  openInbox()
    .prepare(
      `INSERT INTO table_qr_links (cloud_url, pos_table_id, url, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (cloud_url, pos_table_id) DO UPDATE SET url = excluded.url,
         expires_at = excluded.expires_at`,
    )
    .run(config.cloudUrl, table.id, url.href, result.expires_at);
  return { data_url, url: url.href, expires_at: result.expires_at };
}

/**
 * The table's cloud QR as last opened. The cloud keeps one fixed link per table, so staff can show it
 * at once while the table is opened again in the background.
 */
export async function cachedCloudTableQr(tableId: string): Promise<CloudTableQr | null> {
  const row = openInbox()
    .prepare('SELECT url, expires_at FROM table_qr_links WHERE cloud_url = ? AND pos_table_id = ?')
    .get(readConfig().cloudUrl, tableId) as { url: string; expires_at: string } | undefined;
  if (!row) return null;
  const data_url = await QRCode.toDataURL(row.url, {
    width: 360,
    margin: 4,
    errorCorrectionLevel: 'M',
  });
  return { data_url, url: row.url, expires_at: row.expires_at };
}

/** Closes the table's QR on the cloud ordering page; true once the cloud confirms it. */
export async function closeCloudTableQr(
  table: CloudTableQrTable,
  requestSignal?: AbortSignal,
): Promise<boolean> {
  const config = readConfig();
  const result = (await manageConnectorTableQr(
    {
      config,
      token: readConnectorSetting(),
      caPem: readApprovedCa()?.pem,
      signal: signalFor(config.timeoutMs, requestSignal),
    },
    { action: 'close', pos_table_id: table.id, name: table.number },
  )) as { closed?: unknown } | null;
  if (result?.closed !== true) throw new CloudOrderError('invalid_cloud_table_qr', 502);
  openInbox()
    .prepare('DELETE FROM open_table_qr WHERE cloud_url = ? AND pos_table_id = ?')
    .run(config.cloudUrl, table.id);
  return true;
}
