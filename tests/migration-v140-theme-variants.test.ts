/**
 * Migration v140: theme_light_variant and theme_dark_variant default to "1". A fresh install gets
 * them, an upgrade from v139 adds them without touching an existing theme_mode, and a saved
 * variant survives restart.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v140-fresh-'));

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
const { isThemeVariant } = require('../main/title-bar-theme');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const setting = (db: any, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;

function main() {
  console.log('Migration v140: theme variants');
  for (const ok of ['1', '2', '3']) assertOrThrow(isThemeVariant(ok), `"${ok}" is a variant`);
  for (const bad of ['0', '4', 1, 'light', null, undefined]) {
    assertOrThrow(!isThemeVariant(bad), `${JSON.stringify(bad)} is not a variant`);
  }

  const latest = getLatestSupportedSchemaVersion();

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  assertEqualOrThrow(setting(db, 'theme_light_variant'), '1', 'fresh: light variant is "1"');
  assertEqualOrThrow(setting(db, 'theme_dark_variant'), '1', 'fresh: dark variant is "1"');
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v140-upgrade-'));
  const legacyDb = buildIdealSchemaDb(139, true);
  assertEqualOrThrow(
    legacyDb.pragma('user_version', { simple: true }),
    139,
    'upgrade store starts at v139',
  );
  assertEqualOrThrow(
    setting(legacyDb, 'theme_light_variant'),
    undefined,
    'v139 has no light variant',
  );
  legacyDb
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('theme_mode', 'dark') ON CONFLICT(key) DO UPDATE SET value = 'dark'",
    )
    .run();

  fs.writeFileSync(path.join(activeTestDir, 'flo.db'), legacyDb.serialize());
  legacyDb.close();
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  assertEqualOrThrow(setting(db, 'theme_mode'), 'dark', 'an existing dark choice survives');
  assertEqualOrThrow(setting(db, 'theme_light_variant'), '1', 'upgrade: light variant is "1"');
  assertEqualOrThrow(setting(db, 'theme_dark_variant'), '1', 'upgrade: dark variant is "1"');

  db.prepare("UPDATE settings SET value = '3' WHERE key = 'theme_dark_variant'").run();
  closeDatabase();
  initDatabase();
  assertEqualOrThrow(
    setting(getDatabase(), 'theme_dark_variant'),
    '3',
    'restart keeps a saved variant',
  );
  closeDatabase();
  console.log('  all migration v140 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
