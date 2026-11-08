/**
 * Migration v136: customers gain first_name, last_name and birthday.
 * A fresh install gets the columns, and an upgrade from v135 keeps every existing customer as it was.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v136-fresh-'));

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

const NEW_COLUMNS = ['first_name', 'last_name', 'birthday'];

function customerColumns(db: any): string[] {
  return (db.prepare('PRAGMA table_info(customers)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function main() {
  console.log('Migration v136: customer first/last name and birthday');
  const latest = getLatestSupportedSchemaVersion();

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  for (const column of NEW_COLUMNS) {
    assertOrThrow(customerColumns(db).includes(column), `fresh database has customers.${column}`);
  }
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v136-upgrade-'));
  const legacyDb = buildIdealSchemaDb(135, true);
  assertEqualOrThrow(
    legacyDb.pragma('user_version', { simple: true }),
    135,
    'upgrade store starts at v135',
  );
  assertOrThrow(
    !customerColumns(legacyDb).includes('birthday'),
    'v135 schema has no birthday column',
  );

  legacyDb
    .prepare(`
    INSERT INTO customers (id, name, phone, country_code, email, address, notes, created_at, updated_at)
    VALUES ('cust-legacy', 'สมชาย ใจดี', '+66812345678', '+66', 'a@example.com', '1 Main Rd', 'VIP', datetime('now'), datetime('now'))
  `)
    .run();
  const before = legacyDb.prepare("SELECT * FROM customers WHERE id = 'cust-legacy'").get();

  fs.writeFileSync(path.join(activeTestDir, 'flo.db'), legacyDb.serialize());
  legacyDb.close();
  initDatabase();
  db = getDatabase();

  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  const after = db.prepare("SELECT * FROM customers WHERE id = 'cust-legacy'").get();
  for (const key of Object.keys(before)) {
    assertEqualOrThrow(after[key], before[key], `existing customers.${key} survives the upgrade`);
  }
  for (const column of NEW_COLUMNS) {
    assertEqualOrThrow(after[column], null, `upgraded customer has a NULL ${column}`);
  }

  db.prepare("UPDATE customers SET birthday = '1985-04-02' WHERE id = 'cust-legacy'").run();
  closeDatabase();
  initDatabase();
  assertEqualOrThrow(
    getDatabase().prepare("SELECT birthday FROM customers WHERE id = 'cust-legacy'").pluck().get(),
    '1985-04-02',
    'restart preserves the saved birthday',
  );
  closeDatabase();
  console.log('  ✓ all migration v136 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
