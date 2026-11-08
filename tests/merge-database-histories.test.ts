import type { Database } from 'better-sqlite3';

const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const originalLoad = Module._load;
let activeTestDir: string;

Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' },
    };
  }
  return originalLoad.apply(this, arguments);
};

const {
  buildIdealSchemaDb,
  closeDatabase,
  getCurrentSchemaVersion,
  getDatabase,
  getLatestSupportedSchemaVersion,
  initDatabase,
} = require('../main/db') as typeof import('../main/db');
const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');
const { WEIGHT_PENDING_NOTE } = require('../main/lib/weight-pending');

function seedLegacyDatabase(version: number, localHistory: boolean): void {
  const db = buildIdealSchemaDb(version, localHistory);
  try {
    assertEqualOrThrow(
      db.pragma('user_version', { simple: true }),
      version,
      'legacy fixture version',
    );
    db.exec(
      "INSERT INTO orders (id, order_number) VALUES (100, 'merge-history-fixture');" +
        'INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, subtotal, total)' +
        " VALUES (100, 100, 'product', 'Fixture item', 45, 45, 45);",
    );

    if (localHistory) {
      db.prepare(
        'UPDATE order_items SET weight = 1.25, special_instructions = ? WHERE id = 100',
      ).run(version === 116 ? WEIGHT_PENDING_NOTE + ' | No chili' : 'No chili');
      if (version === 140) {
        db.exec(
          "UPDATE settings SET value = '3' WHERE key = 'theme_dark_variant';" +
            "INSERT INTO tables (id, number) VALUES ('fixture-table', '123');" +
            'INSERT INTO guest_alerts (id, table_id, kind, created_at)' +
            " VALUES (100, 'fixture-table', 'unlock_request', '2026-01-01 10:00:00');",
        );
      }
    } else {
      db.exec(
        'UPDATE order_items SET price_overridden = 1, original_unit_price = 50 WHERE id = 100',
      );
      if (version === 124) {
        db.exec(
          "UPDATE orders SET scheduled_for = '2099-01-01 10:00:00', release_status = 'scheduled'" +
            ' WHERE id = 100;' +
            "INSERT INTO counters (id, name, role) VALUES ('fixture-counter', 'Counter', 'ordering');",
        );
      }
    }

    fs.writeFileSync(path.join(activeTestDir, 'flo.db'), db.serialize());
  } finally {
    db.close();
  }
}

function assertMergedSchema(db: Database, label: string): void {
  assertEqualOrThrow(
    getCurrentSchemaVersion(),
    getLatestSupportedSchemaVersion(),
    label + ' version',
  );
  const columns = db.pragma('table_info(order_items)') as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  assertOrThrow(names.has('weight_pending') && names.has('weight'), label + ' has local columns');
  assertOrThrow(names.has('price_overridden'), label + ' has upstream columns');
  db.prepare('SELECT id FROM guest_alerts LIMIT 1').get();
  db.prepare('SELECT id FROM counters LIMIT 1').get();
  assertEqualOrThrow(db.pragma('integrity_check', { simple: true }), 'ok', label + ' integrity');
  assertEqualOrThrow(
    (db.pragma('foreign_key_check') as unknown[]).length,
    0,
    label + ' foreign keys',
  );
}

function assertLegacyData(db: Database, version: number, localHistory: boolean): void {
  const item = db
    .prepare(
      'SELECT product_name, total, weight, price_overridden, original_unit_price, special_instructions FROM order_items WHERE id = 100',
    )
    .get() as {
    product_name: string;
    total: number;
    weight: number | null;
    price_overridden: number;
    original_unit_price: number | null;
    special_instructions: string | null;
  };
  assertEqualOrThrow(item.product_name, 'Fixture item', 'existing order item remains');
  assertEqualOrThrow(item.total, 45, 'existing order item total remains');
  assertEqualOrThrow(item.weight, localHistory ? 1.25 : null, 'item weight');
  if (localHistory)
    assertEqualOrThrow(item.special_instructions, 'No chili', 'priced item keeps its kitchen note');
  assertEqualOrThrow(item.price_overridden, localHistory ? 0 : 1, 'price override flag');
  assertEqualOrThrow(item.original_unit_price, localHistory ? null : 50, 'original item price');

  if (localHistory && version === 140) {
    const theme = db
      .prepare("SELECT value FROM settings WHERE key = 'theme_dark_variant'")
      .pluck()
      .get();
    const kind = db.prepare('SELECT kind FROM guest_alerts WHERE id = 100').pluck().get();
    assertEqualOrThrow(theme, '3', 'custom theme remains');
    assertEqualOrThrow(kind, 'unlock_request', 'an existing unlock request survives convergence');
  }
  if (!localHistory && version === 124) {
    const releaseStatus = db
      .prepare('SELECT release_status FROM orders WHERE id = 100')
      .pluck()
      .get();
    const counterRole = db
      .prepare("SELECT role FROM counters WHERE id = 'fixture-counter'")
      .pluck()
      .get();
    assertEqualOrThrow(releaseStatus, 'scheduled', 'scheduled order stays scheduled');
    assertEqualOrThrow(counterRole, 'ordering', 'existing counter remains');
  }
}

delete process.env.FLO_E2E_DB_PATH;

for (const { label, version, localHistory } of [
  { label: 'fresh', version: 0, localHistory: false },
  { label: 'local v116', version: 116, localHistory: true },
  { label: 'local v140', version: 140, localHistory: true },
  { label: 'upstream v116', version: 116, localHistory: false },
  { label: 'upstream v124', version: 124, localHistory: false },
]) {
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-merge-db-histories-'));
  try {
    if (version) seedLegacyDatabase(version, localHistory);
    for (const phase of ['initialization', 'restart']) {
      initDatabase();
      const db = getDatabase();
      assertMergedSchema(db, label + ' ' + phase);
      if (version) assertLegacyData(db, version, localHistory);
      closeDatabase();
    }
  } finally {
    closeDatabase();
    fs.rmSync(activeTestDir, { recursive: true, force: true });
  }
}
