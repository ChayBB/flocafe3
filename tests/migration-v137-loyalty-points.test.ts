/**
 * Migration v137: loyalty points ledger, member tiers, tier audit, customer tier columns and
 * products.points_eligible. A fresh install gets them; an upgrade from v136 keeps every customer,
 * product, cashback entry and the store's cashback mode as they were.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v137-fresh-'));

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

const columns = (db: any, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const hasTable = (db: any, table: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const setting = (db: any, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;

function checkSchema(db: any, label: string) {
  for (const table of ['points_ledger', 'member_tiers', 'member_tier_audit'])
    assertOrThrow(hasTable(db, table), `${label}: ${table} exists`);
  for (const column of [
    'qualifying_cents',
    'tier_code',
    'tier_grace_until',
    'tier_override_code',
    'tier_override_until',
  ])
    assertOrThrow(
      columns(db, 'customers').includes(column),
      `${label}: customers.${column} exists`,
    );
  assertOrThrow(
    columns(db, 'products').includes('points_eligible'),
    `${label}: products.points_eligible exists`,
  );
  assertEqualOrThrow(
    db
      .prepare(
        'SELECT group_concat(code) AS codes FROM (SELECT code FROM member_tiers ORDER BY sort_order)',
      )
      .get().codes,
    'silver,gold,platinum',
    `${label}: default tiers are seeded`,
  );
  assertEqualOrThrow(setting(db, 'loyalty_mode'), 'cashback', `${label}: stores stay on cashback`);
  assertEqualOrThrow(
    setting(db, 'points_spend_per_point'),
    '20',
    `${label}: 20 baht earns a point`,
  );
}

function main() {
  console.log('Migration v137: loyalty points and member tiers');
  const latest = getLatestSupportedSchemaVersion();

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  checkSchema(db, 'fresh');
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v137-upgrade-'));
  const legacyDb = buildIdealSchemaDb(136, true);
  assertEqualOrThrow(
    legacyDb.pragma('user_version', { simple: true }),
    136,
    'upgrade store starts at v136',
  );
  assertOrThrow(!hasTable(legacyDb, 'points_ledger'), 'v136 has no points ledger');

  legacyDb
    .prepare(`
    INSERT INTO customers (id, name, phone, country_code, created_at, updated_at)
    VALUES ('cust-legacy', 'สมชาย ใจดี', '+66812345678', '+66', datetime('now'), datetime('now'))
  `)
    .run();
  legacyDb
    .prepare(`
    INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at)
    VALUES ('cust-legacy', NULL, 'credit', 75, 'Cashback', datetime('now'), datetime('now'))
  `)
    .run();
  const customerBefore = legacyDb.prepare("SELECT * FROM customers WHERE id = 'cust-legacy'").get();
  const walletBefore = legacyDb.prepare('SELECT * FROM loyalty_ledger').all();
  const productsBefore = legacyDb.prepare('SELECT COUNT(*) AS n FROM products').get().n;

  fs.writeFileSync(path.join(activeTestDir, 'flo.db'), legacyDb.serialize());
  legacyDb.close();
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  checkSchema(db, 'upgrade');

  const customerAfter = db.prepare("SELECT * FROM customers WHERE id = 'cust-legacy'").get();
  for (const key of Object.keys(customerBefore))
    assertEqualOrThrow(
      customerAfter[key],
      customerBefore[key],
      `customers.${key} survives the upgrade`,
    );
  assertEqualOrThrow(
    customerAfter.qualifying_cents,
    0,
    'an upgraded customer starts with no tier spend',
  );
  assertEqualOrThrow(
    JSON.stringify(db.prepare('SELECT * FROM loyalty_ledger').all()),
    JSON.stringify(walletBefore),
    'the cashback wallet is untouched',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
    productsBefore,
    'products are kept',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS n FROM products WHERE points_eligible != 1').get().n,
    0,
    'every existing product earns points by default',
  );

  closeDatabase();
  initDatabase();
  assertEqualOrThrow(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM member_tiers').get().n,
    3,
    'restart retains exactly one row per default tier',
  );
  closeDatabase();
  console.log('  all migration v137 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
