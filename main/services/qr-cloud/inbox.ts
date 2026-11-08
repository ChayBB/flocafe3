import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Durable inbox for Cloud events.
 *
 * It is a separate SQLite file from the POS database on purpose: event payloads are
 * customer-facing Cloud data, the POS export/backup must not carry them, and a corrupt inbox
 * must never endanger orders. The schema mirrors the standalone Connector (`inbox_events`,
 * `poll_log`) so existing rows import with their Cloud event ids intact and deduplicate.
 */

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  cloud_created_at TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processing','applied','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_events(status, received_at);
CREATE TABLE IF NOT EXISTS poll_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_count INTEGER NOT NULL,
  result TEXT NOT NULL,
  detail TEXT
);
`;

export interface CloudEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string | null;
}

export interface StoreResult {
  stored: number;
  duplicates: number;
  rejected: number;
}

export interface InboxSummary {
  received: number;
  processing: number;
  applied: number;
  failed: number;
  total: number;
  newest_received_at: string | null;
}

export interface ImportResult {
  source: string;
  backup_path: string;
  copied: number;
  duplicates: number;
  source_rows: number;
}

export class InboxError extends Error {
  constructor(
    public code:
      | 'inbox_dir_unavailable'
      | 'inbox_corrupt'
      | 'import_source_missing'
      | 'import_source_invalid',
  ) {
    super(code);
  }
}

let db: Database.Database | null = null;
let dbPathInUse = '';

/** The connector owns a directory beside the POS data, overridable for tests. */
export function inboxDirectory(): string {
  if (process.env.FLO_QR_CLOUD_DIR) return path.resolve(process.env.FLO_QR_CLOUD_DIR);
  try {
    const { app } = require('electron') as {
      app?: { isPackaged?: boolean; getPath(name: string): string };
    };
    if (app?.isPackaged) return path.join(app.getPath('userData'), 'qr-cloud');
  } catch {
    // Tests and plain Node run without Electron.
  }
  return path.join(process.cwd(), 'qr-cloud');
}

export function inboxPath(): string {
  return path.join(inboxDirectory(), 'inbox.db');
}

export function openInbox(): Database.Database {
  const target = inboxPath();
  if (db && dbPathInUse === target) return db;
  closeInbox();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let opened: Database.Database;
  try {
    opened = new Database(target);
  } catch {
    throw new InboxError('inbox_dir_unavailable');
  }
  try {
    opened.pragma('journal_mode = WAL');
    opened.pragma('busy_timeout = 5000');
    const check = opened.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new InboxError('inbox_corrupt');
    const version = Number(opened.pragma('user_version', { simple: true }));
    if (version < SCHEMA_VERSION) {
      opened.exec(SCHEMA);
      opened.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  } catch (error) {
    opened.close();
    if (error instanceof InboxError) throw error;
    throw new InboxError('inbox_corrupt');
  }
  db = opened;
  dbPathInUse = target;
  return db;
}

export function closeInbox(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    // A closed or busy handle is not worth failing shutdown over.
  }
  db = null;
  dbPathInUse = '';
}

/** Validates one Cloud event. Anything unexpected is rejected rather than stored. */
export function parseCloudEvent(value: unknown): CloudEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 200) return null;
  if (typeof event.kind !== 'string' || event.kind.length === 0 || event.kind.length > 100)
    return null;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
    return null;
  const payloadJson = JSON.stringify(event.payload);
  if (payloadJson.length > 256 * 1024) return null;
  return {
    id: event.id,
    kind: event.kind,
    payload: event.payload as Record<string, unknown>,
    created_at: typeof event.created_at === 'string' ? event.created_at : null,
  };
}

/**
 * Stores events in one transaction. The Cloud event id is the primary key, so a replayed poll
 * stores nothing new: duplicates are counted, never overwritten and never re-processed.
 */
export function storeEvents(events: unknown[]): StoreResult {
  const database = openInbox();
  const insert = database.prepare(
    `INSERT OR IGNORE INTO inbox_events (event_id, kind, payload_json, cloud_created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const exists = database.prepare('SELECT 1 FROM inbox_events WHERE event_id = ?');
  let stored = 0;
  let duplicates = 0;
  let rejected = 0;
  const write = database.transaction((batch: unknown[]) => {
    for (const raw of batch) {
      const event = parseCloudEvent(raw);
      if (!event) {
        rejected += 1;
        continue;
      }
      const result = insert.run(
        event.id,
        event.kind,
        JSON.stringify(event.payload),
        event.created_at,
      );
      if (result.changes === 1) stored += 1;
      else if (exists.get(event.id)) duplicates += 1;
      else rejected += 1;
    }
  });
  write(events);
  return { stored, duplicates, rejected };
}

export function recordPoll(eventCount: number, result: 'ok' | 'error', detail?: string): void {
  try {
    openInbox()
      .prepare('INSERT INTO poll_log (event_count, result, detail) VALUES (?, ?, ?)')
      .run(eventCount, result, detail ? detail.slice(0, 200) : null);
  } catch {
    // Diagnostics must never break the poll loop.
  }
}

export function recentPolls(
  limit = 20,
): Array<{ checked_at: string; event_count: number; result: string; detail: string | null }> {
  try {
    return openInbox()
      .prepare(
        'SELECT checked_at, event_count, result, detail FROM poll_log ORDER BY id DESC LIMIT ?',
      )
      .all(Math.min(Math.max(limit, 1), 100)) as Array<{
      checked_at: string;
      event_count: number;
      result: string;
      detail: string | null;
    }>;
  } catch {
    return [];
  }
}

export function inboxSummary(): InboxSummary {
  const empty: InboxSummary = {
    received: 0,
    processing: 0,
    applied: 0,
    failed: 0,
    total: 0,
    newest_received_at: null,
  };
  try {
    const database = openInbox();
    const rows = database
      .prepare('SELECT status, COUNT(*) AS total FROM inbox_events GROUP BY status')
      .all() as Array<{ status: keyof InboxSummary; total: number }>;
    const summary = { ...empty };
    for (const row of rows) {
      if (row.status in summary && typeof summary[row.status] === 'number') {
        (summary[row.status] as number) = row.total;
      }
      summary.total += row.total;
    }
    const newest = database.prepare('SELECT MAX(received_at) AS newest FROM inbox_events').get() as
      | { newest: string | null }
      | undefined;
    summary.newest_received_at = newest?.newest ?? null;
    return summary;
  } catch {
    return empty;
  }
}

/** Clears stored error text only. Events and their statuses are never deleted here. */
export function clearErrorHistory(): number {
  const database = openInbox();
  const cleared = database.transaction(() => {
    const events = database
      .prepare('UPDATE inbox_events SET last_error = NULL WHERE last_error IS NOT NULL')
      .run();
    const polls = database
      .prepare('UPDATE poll_log SET detail = NULL WHERE detail IS NOT NULL')
      .run();
    return events.changes + polls.changes;
  })();
  return cleared;
}

/**
 * Copies an existing standalone Connector inbox into this inbox.
 *
 * The source file is opened read-only and never modified; a byte copy is written beside it as a
 * backup first. Rows keep their Cloud event ids, so re-running the import copies nothing twice.
 */
export function importLegacyInbox(sourcePath: string): ImportResult {
  const source = path.resolve(sourcePath);
  // Only the standalone Connector's own database may be imported: an operator-supplied arbitrary
  // path would otherwise read and copy any SQLite file this process can open.
  if (path.basename(source) !== 'connector.db') throw new InboxError('import_source_invalid');
  if (!fs.existsSync(source)) throw new InboxError('import_source_missing');
  let legacy: Database.Database;
  try {
    legacy = new Database(source, { readonly: true, fileMustExist: true });
  } catch {
    throw new InboxError('import_source_invalid');
  }
  try {
    const tables = legacy
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inbox_events','poll_log')",
      )
      .all() as Array<{ name: string }>;
    if (!tables.some((table) => table.name === 'inbox_events'))
      throw new InboxError('import_source_invalid');
    const rows = legacy
      .prepare(
        'SELECT event_id, kind, payload_json, cloud_created_at, status, received_at FROM inbox_events',
      )
      .all() as Array<{
      event_id: string;
      kind: string;
      payload_json: string;
      cloud_created_at: string | null;
      status: string;
      received_at: string;
    }>;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${source}.pre-qr-cloud-import-${stamp}.bak`;
    fs.copyFileSync(source, backupPath);

    const database = openInbox();
    const insert = database.prepare(
      `INSERT OR IGNORE INTO inbox_events
         (event_id, kind, payload_json, cloud_created_at, status, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let copied = 0;
    let duplicates = 0;
    database.transaction(() => {
      for (const row of rows) {
        const status = ['received', 'processing', 'applied', 'failed'].includes(row.status)
          ? row.status
          : 'received';
        const result = insert.run(
          row.event_id,
          row.kind,
          row.payload_json,
          row.cloud_created_at,
          status,
          row.received_at,
          row.received_at,
        );
        if (result.changes === 1) copied += 1;
        else duplicates += 1;
      }
    })();
    return { source, backup_path: backupPath, copied, duplicates, source_rows: rows.length };
  } finally {
    legacy.close();
  }
}
