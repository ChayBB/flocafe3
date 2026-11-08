/**
 * Migration v138: promotion rule engine tables. A fresh install gets them; an upgrade from v137
 * keeps existing orders and discounts, adds no promotions, and redemptions are append-only.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v138-fresh-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  buildIdealSchemaDb,
  getLatestSupportedSchemaVersion,
  closeDatabase,
} = require('../main/db');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const TABLES = ['promotions', 'promotion_codes', 'order_promotions', 'promotion_redemptions'];
const hasTable = (db: any, table: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

function checkSchema(db: any, label: string) {
  for (const table of TABLES) assertOrThrow(hasTable(db, table), `${label}: ${table} exists`);
  assertOrThrow(
    db
      .prepare('PRAGMA table_info(orders)')
      .all()
      .some((c: any) => c.name === 'coupon_codes'),
    `${label}: orders.coupon_codes exists`,
  );
  assertEqualOrThrow(
    (
      db
        .prepare("SELECT value FROM settings WHERE key = 'promotion_max_total_discount_cents'")
        .get() as any
    )?.value,
    '0',
    `${label}: no combined discount cap by default`,
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS n FROM promotions').get().n,
    0,
    `${label}: no promotions are created`,
  );
}

function main() {
  console.log('Migration v138: promotion rule engine tables');
  const latest = getLatestSupportedSchemaVersion();

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  checkSchema(db, 'fresh');
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v138-upgrade-'));
  const legacyDb = buildIdealSchemaDb(137, true);
  assertEqualOrThrow(
    legacyDb.pragma('user_version', { simple: true }),
    137,
    'upgrade store starts at v137',
  );
  assertOrThrow(!hasTable(legacyDb, 'promotions'), 'v137 has no promotions table');
  legacyDb
    .prepare(
      `INSERT INTO orders (order_number, type, status, subtotal, discount_amount, discount_type, discount_value, discount_reason)
     VALUES ('ORD-LEGACY', 'dine_in', 'completed', 500, 50, 'percentage', 10, 'Regular')`,
    )
    .run();
  const before = legacyDb.prepare("SELECT * FROM orders WHERE order_number = 'ORD-LEGACY'").get();

  fs.writeFileSync(path.join(activeTestDir, 'flo.db'), legacyDb.serialize());
  legacyDb.close();
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  checkSchema(db, 'upgrade');
  const after = db.prepare("SELECT * FROM orders WHERE order_number = 'ORD-LEGACY'").get();
  for (const key of Object.keys(before))
    assertEqualOrThrow(after[key], before[key], `orders.${key} survives the upgrade`);

  db.prepare(
    `INSERT INTO promotion_redemptions (promotion_id, kind, uses, discount_cents, created_at)
     VALUES ('p1', 'redeem', 1, 500, datetime('now'))`,
  ).run();
  let blocked = 0;
  for (const sql of [
    'UPDATE promotion_redemptions SET discount_cents = 0',
    'DELETE FROM promotion_redemptions',
  ]) {
    try {
      db.prepare(sql).run();
    } catch {
      blocked += 1;
    }
  }
  assertEqualOrThrow(blocked, 2, 'redemptions cannot be edited or deleted');

  closeDatabase();
  initDatabase();
  assertEqualOrThrow(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM promotion_redemptions').get().n,
    1,
    'restart preserves the redemption ledger',
  );
  closeDatabase();
  console.log('  all migration v138 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
