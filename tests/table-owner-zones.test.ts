/**
 * Automatic table assignment by zone: every zone gets a main staff member before any zone gets a
 * second, and a zone's backups are never its own main staff.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/table-owner-zones.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-owner-zones-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedOwnerUser,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const {
  saveTableStaffRoster,
  shuffleTableStaffNow,
} = require('../main/services/table-owner-rotation');

interface Row {
  number: string;
  floor: string;
  owner_user_id: string | null;
  backup_user_id: string | null;
}

function addUser(db: any, id: string) {
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'server', 1, ?, ?)`,
  ).run(id, id, `${id}@test.local`, now(), now());
}

function resetTables(db: any, zones: [string, number][]) {
  db.prepare('DELETE FROM tables').run();
  let number = 1;
  for (const [floor, count] of zones) {
    for (let i = 0; i < count; i += 1, number += 1) {
      db.prepare(
        `INSERT INTO tables (id, number, capacity, status, is_active, floor)
         VALUES (?, ?, 4, 'available', 1, ?)`,
      ).run(`t${number}`, String(number), floor);
    }
  }
}

function byZone(db: any): Map<string, Row[]> {
  const rows = db
    .prepare('SELECT number, floor, owner_user_id, backup_user_id FROM tables')
    .all() as Row[];
  const zones = new Map<string, Row[]>();
  for (const row of rows) zones.set(row.floor, [...(zones.get(row.floor) ?? []), row]);
  return zones;
}

function shuffle(db: any, actor: string, present: string[]) {
  saveTableStaffRoster(db, { presentIds: new Set(present), tableCount: null }, actor);
  assertOrThrow(shuffleTableStaffNow(db, actor), 'shuffle runs with present staff');
}

function checkBackups(zones: Map<string, Row[]>, label: string) {
  for (const [zone, rows] of zones) {
    const mains = new Set(rows.map((row) => row.owner_user_id));
    assertOrThrow(
      rows.every((row) => row.backup_user_id && !mains.has(row.backup_user_id)),
      `${label}: every backup in zone ${zone} is someone other than its main staff`,
    );
  }
}

function main() {
  console.log('Table assignment by zone');
  console.log('='.repeat(60));
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const staff = Array.from({ length: 10 }, (_, i) => `staff-${i + 1}`);
  staff.forEach((id) => addUser(db, id));
  const shopZones: [string, number][] = [
    ['2-8', 7],
    ['9-15', 7],
    ['17-22', 6],
    ['23-30', 8],
    ['31-36', 6],
    ['37-42', 6],
    ['43-48', 6],
    ['49-54', 6],
    ['55-60', 6],
    ['61-66', 6],
    ['67-72', 6],
  ];

  resetTables(db, shopZones);
  for (let round = 0; round < 5; round += 1) {
    shuffle(db, owner.userId, [...staff]);
    const zones = byZone(db);
    for (const [zone, rows] of zones) {
      const mains = new Set(rows.map((row) => row.owner_user_id));
      assertOrThrow(
        rows.every((row) => row.owner_user_id),
        `fewer staff than zones: every table in ${zone} has a main staff member`,
      );
      assertEqualOrThrow(mains.size, 1, `fewer staff than zones: zone ${zone} is never split`);
    }
    checkBackups(zones, 'fewer staff than zones');
    const zonesPerPerson = new Map<string, number>();
    for (const rows of zones.values()) {
      const id = rows[0].owner_user_id as string;
      zonesPerPerson.set(id, (zonesPerPerson.get(id) ?? 0) + 1);
    }
    assertEqualOrThrow(zonesPerPerson.size, 10, 'all 10 present staff get a zone');
  }

  resetTables(db, shopZones.slice(0, 6));
  for (let round = 0; round < 5; round += 1) {
    shuffle(db, owner.userId, [...staff]);
    const zones = byZone(db);
    const counts = [...zones.values()].map(
      (rows) => new Set(rows.map((row) => row.owner_user_id)).size,
    );
    assertOrThrow(
      [...zones.values()].every((rows) => rows.every((row) => row.owner_user_id)),
      'more staff than zones: every table has a main staff member',
    );
    assertOrThrow(
      counts.every((count) => count >= 1 && count <= 2),
      `more staff than zones: each zone gets one or two main staff (${counts.join(',')})`,
    );
    assertEqualOrThrow(
      counts.reduce((sum, count) => sum + count, 0),
      10,
      'more staff than zones: every present person gets tables',
    );
    checkBackups(zones, 'more staff than zones');
  }

  resetTables(db, [['Hall', 9]]);
  shuffle(db, owner.userId, staff.slice(0, 3));
  const hall = byZone(db).get('Hall') as Row[];
  assertEqualOrThrow(
    new Set(hall.map((row) => row.owner_user_id)).size,
    3,
    'one zone splits between its present staff',
  );
  assertOrThrow(
    hall.every((row) => row.backup_user_id && row.backup_user_id !== row.owner_user_id),
    'one zone: backups are another person in the zone',
  );

  resetTables(db, [['Bar', 1]]);
  shuffle(db, owner.userId, staff.slice(0, 2));
  const [bar] = byZone(db).get('Bar') as Row[];
  assertOrThrow(
    bar.owner_user_id && bar.backup_user_id && bar.backup_user_id !== bar.owner_user_id,
    'a lone table is backed up by a present person who has no tables',
  );

  console.log('\n✅ All table assignment by zone tests passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
}
