/**
 * Printer kitchen ticket layout migration: printers keep the shop-wide layout they printed with.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-kot-layout-'));

Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const assert = require('node:assert/strict');
const { initDatabase, getDatabase, closeDatabase, MIGRATIONS } = require('../main/db');

function main() {
  initDatabase();
  const db = getDatabase();
  const migration = MIGRATIONS.find((m: any) => m.name === 'add_printer_kot_print_layout');
  assert.ok(migration, 'the printer layout migration is registered');

  db.prepare(
    `INSERT INTO printers (name, connection_type, ip_address, port) VALUES ('Kitchen', 'network', '127.0.0.1', 9100)`,
  ).run();
  assert.equal(
    db.prepare('SELECT kot_print_layout FROM printers').get().kot_print_layout,
    'combined',
    'fresh databases default a printer to combined tickets',
  );
  assert.throws(
    () => db.prepare(`UPDATE printers SET kot_print_layout = 'stacked'`).run(),
    'the column rejects an unknown layout',
  );

  for (const [shopWide, expected] of [
    [undefined, 'combined'],
    ['combined', 'combined'],
    ['separate', 'separate'],
    ['both', 'both'],
  ]) {
    db.exec('ALTER TABLE printers DROP COLUMN kot_print_layout');
    db.prepare(`DELETE FROM settings WHERE key = 'kot_print_layout'`).run();
    if (shopWide) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('kot_print_layout', ?, datetime('now'))`,
      ).run(shopWide);
    }
    migration.up();
    assert.equal(
      db.prepare('SELECT kot_print_layout FROM printers').get().kot_print_layout,
      expected,
      `a shop-wide ${shopWide ?? 'unset'} layout upgrades printers to ${expected}`,
    );
    assert.equal(
      db.prepare('SELECT name FROM printers').get().name,
      'Kitchen',
      'existing printers survive the upgrade',
    );
  }
  console.log('✅ Printer kitchen ticket layout migration tests passed');
}

try {
  main();
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
} catch (error) {
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
}
