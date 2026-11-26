/**
 * Migration v148: staff plans and the part-time staff tag. A fresh install gets both, and an
 * upgrade from v147 keeps every existing user and table assignment.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v148-fresh-'));

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
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column: any) => column.name);
const hasTable = (db: any, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

function checkSchema(db: any, label: string) {
  assertOrThrow(columns(db, 'users').includes('part_time'), `${label}: users.part_time exists`);
  assertOrThrow(hasTable(db, 'table_staff_plans'), `${label}: table_staff_plans exists`);
  assertOrThrow(hasTable(db, 'table_staff_plan_tables'), `${label}: plan tables exist`);
}

function main() {
  console.log('Migration v148: table staff plans');
  const latest = getLatestSupportedSchemaVersion();
  assertOrThrow(latest >= 148, 'v148 is a supported schema');

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  checkSchema(db, 'fresh');
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v148-upgrade-'));
  const legacyDb = buildIdealSchemaDb(147);
  assertEqualOrThrow(
    legacyDb.pragma('user_version', { simple: true }),
    147,
    'upgrade starts at v147',
  );
  assertOrThrow(!columns(legacyDb, 'users').includes('part_time'), 'v147 has no part_time');
  legacyDb
    .prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES ('keep-me', 'Keep', 'keep@test.local', 'x', 'server', 1, '2026-01-01', '2026-01-01')`,
    )
    .run();
  legacyDb
    .prepare(
      `INSERT INTO tables (id, number, capacity, status, is_active, floor, owner_user_id, backup_user_id)
       VALUES ('t-keep', '9', 4, 'available', 1, 'Hall', 'keep-me', NULL)`,
    )
    .run();
  fs.writeFileSync(path.join(activeTestDir, 'flo.db'), legacyDb.serialize());
  legacyDb.close();

  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  checkSchema(db, 'upgrade');
  const kept = db.prepare("SELECT name, part_time FROM users WHERE id = 'keep-me'").get();
  assertEqualOrThrow(kept?.name, 'Keep', 'existing staff survive the upgrade');
  assertEqualOrThrow(kept?.part_time, 0, 'existing staff start as not part-time');
  assertEqualOrThrow(
    db.prepare("SELECT owner_user_id FROM tables WHERE id = 't-keep'").get()?.owner_user_id,
    'keep-me',
    'existing table assignments survive the upgrade',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS n FROM table_staff_plans').get().n,
    0,
    'an upgrade starts with no plans',
  );
  closeDatabase();
  console.log('  all migration v148 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
