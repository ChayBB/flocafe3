/**
 * Table staff assignment: today's attendance, service table count, and the manual,
 * rotate-daily and shuffle-every-X-days modes that spread tables over present staff.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/table-owner-rotation.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-owner-rotation-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { tableRoutes } = require('../main/routes/tables');
const {
  readTableOwnerAssignmentSettings,
  readTableStaffRoster,
  runTableOwnerAssignmentIfDue,
  saveTableStaffRoster,
  updateTableOwnerAssignmentSettings,
} = require('../main/services/table-owner-rotation');
const { currentBusinessDate } = require('../main/services/attendance');
const { formatTableRanges } = require('../frontend/src/lib/table-ranges');

function backupsOf(db: any): Record<string, string | null> {
  const rows = db.prepare('SELECT id, backup_user_id FROM tables ORDER BY id').all();
  return Object.fromEntries(rows.map((row: any) => [row.id, row.backup_user_id]));
}

function addUser(db: any, id: string, role: string, active = 1) {
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
  ).run(id, id, `${id}@test.local`, role, active, now(), now());
}

function addTable(
  db: any,
  id: string,
  number: string,
  floor: string,
  owner: string | null,
  active = 1,
) {
  db.prepare(
    `INSERT INTO tables (id, number, capacity, status, is_active, floor, owner_user_id)
     VALUES (?, ?, 4, 'available', ?, ?, ?)`,
  ).run(id, number, active, floor, owner);
}

function owners(db: any): Record<string, string | null> {
  const rows = db.prepare('SELECT id, owner_user_id FROM tables ORDER BY id').all();
  return Object.fromEntries(rows.map((row: any) => [row.id, row.owner_user_id]));
}

const ORDERED = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];

function runSizes(map: Record<string, string | null>): number[] {
  const counts = new Map<string, number>();
  for (const id of ORDERED) {
    const owner = map[id];
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.values()].sort((a, b) => a - b);
}

function contiguous(map: Record<string, string | null>): boolean {
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const id of ORDERED) {
    const owner = map[id];
    if (owner && owner !== previous) {
      if (seen.has(owner)) return false;
      seen.add(owner);
    }
    previous = owner;
  }
  return true;
}

const roster = (ids: string[], tableCount: number | null = null) => ({
  presentIds: new Set(ids),
  tableCount,
});

async function main() {
  console.log('Table staff assignment');
  console.log('='.repeat(60));
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  addUser(db, 'staff-a', 'server');
  addUser(db, 'staff-b', 'server');
  addUser(db, 'staff-c', 'server');
  addUser(db, 'staff-gone', 'server', 0);
  addUser(db, 'cashier-1', 'cashier');
  addTable(db, 't1', '1', 'Indoor', 'staff-a');
  addTable(db, 't2', '2', 'Indoor', 'staff-a');
  addTable(db, 't3', '3', 'Indoor', null);
  addTable(db, 't4', '4', 'Patio', 'staff-b');
  addTable(db, 't5', '5', 'Patio', null);
  addTable(db, 't6', '6', 'Terrace', 'staff-c');
  addTable(db, 't7', '7', 'Terrace', null);
  addTable(db, 't9', '9', 'Terrace', 'staff-gone', 0);

  const { getJWTSecret } = require('../main/routes/auth');
  const cashierHeader = {
    Authorization: `Bearer ${require('jsonwebtoken').sign(
      { userId: 'cashier-1', email: 'cashier-1@test.local', role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' },
    )}`,
  };
  const app = createApp({ '/api/tables': tableRoutes });
  const { baseUrl, server } = await startServer(app);
  const putRoster = (body: unknown, headers = owner.authHeader) =>
    api(baseUrl, '/api/tables/staff-roster', { method: 'PUT', headers, body });

  try {
    // ── Defaults ──
    assertEqualOrThrow(
      readTableOwnerAssignmentSettings(db).mode,
      'manual',
      'installs default to manual',
    );
    const today = currentBusinessDate(db);
    const rosterRes = await api(baseUrl, '/api/tables/staff-roster', { headers: owner.authHeader });
    assertEqualOrThrow(rosterRes.status, 200, 'owner reads today’s roster');
    assertEqualOrThrow(
      rosterRes.data.business_date,
      today,
      'roster is for the store business date',
    );
    assertOrThrow(
      typeof rosterRes.data.store_timezone === 'string',
      'roster carries the store timezone',
    );
    assertEqualOrThrow(
      rosterRes.data.staff
        .map((s: any) => s.id)
        .sort()
        .join(','),
      'cashier-1,owner-test-001,staff-a,staff-b,staff-c',
      'roster lists active assignable staff only',
    );
    assertOrThrow(
      rosterRes.data.staff.every((s: any) => s.present),
      'everyone starts present',
    );
    assertEqualOrThrow(rosterRes.data.table_count, 7, 'service tables default to active tables');
    assertEqualOrThrow(rosterRes.data.table_count_custom, false, 'default count is not custom');

    // ── Validation and authorization ──
    assertEqualOrThrow(
      (await putRoster({ present_user_ids: ['staff-a'] }, cashierHeader)).status,
      403,
      'cashier cannot save the roster',
    );
    assertEqualOrThrow(
      (await putRoster({ present_user_ids: 'staff-a' })).status,
      400,
      'present ids must be a list',
    );
    assertEqualOrThrow(
      (await putRoster({ present_user_ids: ['nobody'] })).status,
      400,
      'unknown staff is rejected',
    );
    assertEqualOrThrow(
      (await putRoster({ present_user_ids: ['staff-gone'] })).status,
      400,
      'inactive staff is rejected',
    );
    for (const bad of [0, 8, 2.5, '3']) {
      const res = await putRoster({ present_user_ids: ['staff-a'], table_count: bad });
      assertEqualOrThrow(res.status, 400, `table_count ${JSON.stringify(bad)} is rejected`);
    }

    // ── Manual mode only stores the information ──
    const manualBefore = owners(db);
    const manualSave = await putRoster({
      present_user_ids: ['staff-a', 'staff-b'],
      table_count: 6,
    });
    assertEqualOrThrow(manualSave.status, 200, 'roster saves in manual mode');
    assertEqualOrThrow(manualSave.data.changes, 0, 'manual mode moves nobody');
    assertEqualOrThrow(
      JSON.stringify(owners(db)),
      JSON.stringify(manualBefore),
      'manual keeps owners',
    );
    const stored = readTableStaffRoster(db);
    assertEqualOrThrow(
      stored.staff.filter((s: any) => s.present).length,
      2,
      'attendance persists for the day',
    );
    assertEqualOrThrow(stored.table_count, 6, 'custom table count persists');
    assertEqualOrThrow(stored.table_count_custom, true, 'custom count is flagged');

    // ── Choosing an automatic mode assigns today's tables at once ──
    const modeRes = await api(baseUrl, '/api/tables/owner-assignment', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { mode: 'rotate_daily' },
    });
    assertEqualOrThrow(modeRes.status, 200, 'owner switches to daily rotation');
    const switched = owners(db);
    assertOrThrow(modeRes.data.changes > 0, 'switching to rotation reports its changes');
    assertEqualOrThrow(
      runSizes(switched).join(','),
      '3,3',
      'switching assigns today’s 6 service tables over the 2 present staff',
    );
    assertOrThrow(
      ORDERED.slice(0, 6).every((id) => ['staff-a', 'staff-b'].includes(switched[id] as string)),
      'only today’s present staff get tables on the switch',
    );
    assertEqualOrThrow(switched.t7, null, 'tables past the service count stay unassigned');
    assertEqualOrThrow(
      backupsOf(db).t1,
      switched.t1 === 'staff-a' ? 'staff-b' : 'staff-a',
      'the switch also sets backups',
    );
    const switchAudit = db
      .prepare("SELECT * FROM table_owner_audit WHERE action = 'rotate_daily'")
      .all();
    assertEqualOrThrow(switchAudit.length, modeRes.data.changes, 'the switch run is audited');
    assertOrThrow(
      switchAudit.every((row: any) => row.actor_user_id === owner.userId),
      'the switch run is attributed to the manager',
    );
    assertEqualOrThrow(modeRes.data.last_run, today, 'the switch counts as today’s run');
    assertEqualOrThrow(
      runTableOwnerAssignmentIfDue(db).ran,
      false,
      'the boundary check does not run again the same day',
    );
    const sameMode = await api(baseUrl, '/api/tables/owner-assignment', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { mode: 'rotate_daily' },
    });
    assertEqualOrThrow(sameMode.data.changes, 0, 'choosing the current mode again changes nothing');
    assertEqualOrThrow(
      db.prepare("SELECT actor_user_id FROM table_owner_audit WHERE action = 'mode_changed'").get()
        ?.actor_user_id,
      owner.userId,
      'mode change is attributed',
    );

    // ── Saving the roster in an automatic mode spreads tables over present staff ──
    const autoSave = await putRoster({
      present_user_ids: ['staff-a', 'staff-b', 'staff-c'],
      table_count: null,
    });
    assertEqualOrThrow(autoSave.status, 200, 'roster saves in rotate mode');
    let current = owners(db);
    assertOrThrow(
      ORDERED.every((id) => ['staff-a', 'staff-b', 'staff-c'].includes(current[id] as string)),
      'only present staff get tables',
    );
    assertEqualOrThrow(runSizes(current).join(','), '2,2,3', '7 tables over 3 staff split 2/2/3');
    assertOrThrow(contiguous(current), 'each staff member gets a contiguous run of tables');
    assertEqualOrThrow(current.t9, 'staff-gone', 'inactive tables are untouched');
    const backups = backupsOf(db);
    const backupByOwner = new Map<string, Set<string | null>>();
    for (const id of ORDERED) {
      const set = backupByOwner.get(current[id] as string) ?? new Set();
      set.add(backups[id]);
      backupByOwner.set(current[id] as string, set);
    }
    assertOrThrow(
      [...backupByOwner.values()].every((set) => set.size === 1),
      'one backup covers a whole run',
    );
    const backupFor = [...backupByOwner.entries()].map(([ownerId, set]) => [ownerId, [...set][0]]);
    assertOrThrow(
      backupFor.every(([ownerId, backupId]) => backupId && backupId !== ownerId),
      'every run has a present backup who is not its owner',
    );
    assertEqualOrThrow(
      new Set(backupFor.map(([, backupId]) => backupId)).size,
      3,
      'each present person backs up exactly one neighbouring run',
    );
    const rosterView = (
      await api(baseUrl, '/api/tables/staff-roster', { headers: owner.authHeader })
    ).data;
    const viewA = rosterView.staff.find((m: any) => m.id === 'staff-a');
    assertEqualOrThrow(
      viewA.tables
        .map((x: any) => x.id)
        .sort()
        .join(','),
      ORDERED.filter((id) => current[id] === 'staff-a').join(','),
      'roster lists each person’s own tables',
    );
    assertEqualOrThrow(
      viewA.backup_tables
        .map((x: any) => x.id)
        .sort()
        .join(','),
      ORDERED.filter((id) => backups[id] === 'staff-a').join(','),
      'roster lists each person’s backup tables',
    );
    const rosterAudit = db
      .prepare("SELECT * FROM table_owner_audit WHERE action = 'roster_changed'")
      .all();
    assertEqualOrThrow(
      rosterAudit.length,
      autoSave.data.changes,
      'every roster-driven change is audited',
    );
    assertOrThrow(
      rosterAudit.every((row: any) => row.actor_user_id === owner.userId),
      'roster changes are attributed',
    );

    const fewer = await putRoster({
      present_user_ids: ['staff-a', 'staff-b', 'staff-c'],
      table_count: 5,
    });
    assertEqualOrThrow(fewer.status, 200, 'service table count can be lowered');
    current = owners(db);
    assertEqualOrThrow(current.t6, null, 'tables past the service count lose their owner');
    assertEqualOrThrow(current.t7, null, 'the last tables are not served');
    assertEqualOrThrow(runSizes(current).join(','), '1,2,2', '5 tables over 3 staff split 1/2/2');

    const resave = await putRoster({
      present_user_ids: ['staff-a', 'staff-b', 'staff-c'],
      table_count: 5,
    });
    assertEqualOrThrow(resave.data.changes, 0, 'saving the same roster again changes nothing');

    const nobody = await putRoster({ present_user_ids: [], table_count: 5 });
    assertEqualOrThrow(nobody.data.changes, 0, 'with nobody present the owners are left alone');

    // ── Daily rotation at the business-day boundary ──
    const d0 = '2030-01-10';
    const d1 = '2030-01-11';
    updateTableOwnerAssignmentSettings(db, { mode: 'manual', shuffle_days: 7 }, owner.userId);
    updateTableOwnerAssignmentSettings(db, { mode: 'rotate_daily', shuffle_days: 7 }, owner.userId);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'table_owner_assignment_last_run'").run(
      d0,
    );
    saveTableStaffRoster(db, roster(['staff-a', 'staff-b', 'staff-c']), owner.userId, d0);
    const day0 = owners(db);
    assertEqualOrThrow(
      runTableOwnerAssignmentIfDue(db, { businessDate: d0 }).ran,
      false,
      'same business day does not rotate',
    );
    const first = runTableOwnerAssignmentIfDue(db, { businessDate: d1 });
    assertEqualOrThrow(first.ran, true, 'next business day rotates');
    const day1 = owners(db);
    assertOrThrow(
      ORDERED.some((id) => day1[id] !== day0[id]),
      'rotation moves staff to different tables',
    );
    assertEqualOrThrow(
      runSizes(day1).join(','),
      '1,1,1,2,2',
      'a new day starts with everyone present (7 over 5)',
    );
    const rotateAudit = db
      .prepare(
        "SELECT * FROM table_owner_audit WHERE action = 'rotate_daily' AND business_date = ?",
      )
      .all(d1);
    assertEqualOrThrow(
      rotateAudit.length,
      first.changes.length,
      'every automatic change is audited',
    );
    assertOrThrow(
      rotateAudit.every((row: any) => row.actor_user_id === null),
      'automatic changes have no human actor',
    );
    assertOrThrow(
      rotateAudit.every((row: any) => row.business_date === d1),
      'audit keeps the business date',
    );
    assertEqualOrThrow(
      runTableOwnerAssignmentIfDue(db, { businessDate: d1 }).ran,
      false,
      'a second check on the same day is a no-op',
    );

    saveTableStaffRoster(db, roster(['staff-a', 'staff-b', 'staff-c']), owner.userId, d1);
    const d1Three = owners(db);
    assertOrThrow(
      ORDERED.some((id) => d1Three[id] !== day0[id]),
      'the same staff get a shifted order on the next day',
    );

    const caughtUp = runTableOwnerAssignmentIfDue(db, { businessDate: '2030-01-15' });
    assertEqualOrThrow(caughtUp.ran, true, 'a missed boundary is caught up on the next check');
    assertEqualOrThrow(
      readTableOwnerAssignmentSettings(db).last_run,
      '2030-01-15',
      'catch-up runs once and records today',
    );

    // ── Shuffle every X days ──
    updateTableOwnerAssignmentSettings(
      db,
      { mode: 'shuffle_interval', shuffle_days: 3 },
      owner.userId,
    );
    db.prepare(
      "UPDATE settings SET value = '2030-02-01' WHERE key = 'table_owner_assignment_last_run'",
    ).run();
    saveTableStaffRoster(db, roster(['staff-a', 'staff-b', 'staff-c']), owner.userId, '2030-02-03');
    const periodOwners = owners(db);
    const again = saveTableStaffRoster(
      db,
      roster(['staff-a', 'staff-b', 'staff-c']),
      owner.userId,
      '2030-02-03',
    );
    assertEqualOrThrow(
      again.changes.length,
      0,
      'within one shuffle period the draw stays the same',
    );
    assertEqualOrThrow(
      runTableOwnerAssignmentIfDue(db, { businessDate: '2030-02-03' }).ran,
      false,
      'shuffle waits for the full interval',
    );
    saveTableStaffRoster(db, roster(['staff-a', 'staff-b', 'staff-c']), owner.userId, '2030-02-04');
    const shuffled = runTableOwnerAssignmentIfDue(db, { businessDate: '2030-02-04' });
    assertEqualOrThrow(shuffled.ran, true, 'shuffle runs after X business days');
    const afterShuffle = owners(db);
    assertEqualOrThrow(runSizes(afterShuffle).join(','), '2,2,3', 'shuffle keeps the even split');
    assertOrThrow(contiguous(afterShuffle), 'shuffle keeps contiguous runs');
    assertOrThrow(periodOwners.t1 !== undefined, 'period owners were captured');

    // ── Back to manual ──
    updateTableOwnerAssignmentSettings(db, { mode: 'manual', shuffle_days: 3 }, owner.userId);
    const manualOwners = owners(db);
    runTableOwnerAssignmentIfDue(db, { businessDate: '2030-03-01' });
    saveTableStaffRoster(db, roster(['staff-a']), owner.userId, '2030-03-01');
    assertEqualOrThrow(
      JSON.stringify(owners(db)),
      JSON.stringify(manualOwners),
      'manual mode stops automatic changes',
    );

    // ── "+" hands extra tables to one person ──
    const putStaffTables = (body: unknown, headers = owner.authHeader) =>
      api(baseUrl, '/api/tables/staff-tables', { method: 'PUT', headers, body });
    db.prepare(
      "UPDATE tables SET owner_user_id = CASE WHEN id IN ('t1','t2') THEN 'staff-a' WHEN id IN ('t3','t4') THEN 'staff-b' ELSE NULL END, backup_user_id = NULL WHERE is_active = 1",
    ).run();
    assertEqualOrThrow(
      (
        await putStaffTables(
          { user_id: 'staff-c', table_ids: ['t3'], kind: 'owner' },
          cashierHeader,
        )
      ).status,
      403,
      'cashier cannot hand out tables',
    );
    assertEqualOrThrow(
      (await putStaffTables({ user_id: 'staff-c', table_ids: ['t3'], kind: 'boss' })).status,
      400,
      'unknown kind is rejected',
    );
    assertEqualOrThrow(
      (await putStaffTables({ user_id: 'staff-gone', table_ids: ['t3'], kind: 'owner' })).status,
      400,
      'inactive staff cannot take tables',
    );
    assertEqualOrThrow(
      (await putStaffTables({ user_id: 'staff-c', table_ids: [], kind: 'owner' })).status,
      400,
      'an empty table list is rejected',
    );
    assertEqualOrThrow(
      (await putStaffTables({ user_id: 'staff-c', table_ids: ['t9'], kind: 'owner' })).status,
      400,
      'inactive tables cannot be handed out',
    );
    assertEqualOrThrow(
      (await putStaffTables({ user_id: 'staff-a', table_ids: ['t1'], kind: 'backup' })).status,
      400,
      'nobody backs up their own table',
    );
    const backupRes = await putStaffTables({
      user_id: 'staff-c',
      table_ids: ['t1', 't2'],
      kind: 'backup',
    });
    assertEqualOrThrow(backupRes.status, 200, 'manager adds backup tables');
    assertEqualOrThrow(backupsOf(db).t1, 'staff-c', 'backup is stored');
    assertEqualOrThrow(owners(db).t1, 'staff-a', 'adding a backup keeps the owner');
    const takeRes = await putStaffTables({
      user_id: 'staff-c',
      table_ids: ['t1', 't3'],
      kind: 'owner',
    });
    assertEqualOrThrow(takeRes.status, 200, 'manager moves tables to one person');
    assertEqualOrThrow(owners(db).t1, 'staff-c', 'a backup table can be taken over');
    assertEqualOrThrow(owners(db).t3, 'staff-c', 'another person’s table moves over');
    assertEqualOrThrow(owners(db).t4, 'staff-b', 'tables not picked stay put');
    assertEqualOrThrow(backupsOf(db).t1, null, 'taking a table as owner clears them as its backup');
    assertEqualOrThrow(backupsOf(db).t2, 'staff-c', 'other backups stay');
    const manualAudit = db
      .prepare("SELECT * FROM table_owner_audit WHERE action = 'manual_assign' AND table_id = 't3'")
      .get();
    assertEqualOrThrow(manualAudit?.previous_user_id, 'staff-b', 'audit names the previous owner');
    assertEqualOrThrow(manualAudit?.actor_user_id, owner.userId, 'manual changes are attributed');

    // ── Compact table ranges ──
    assertEqualOrThrow(
      formatTableRanges(['1', '2', '3', '4', '5', '7', '8', '9', '10']),
      '1-5, 7-10',
      'runs collapse',
    );
    assertEqualOrThrow(
      formatTableRanges(['01', '2', '15']),
      '1-2, 15',
      'leading zeros count as numbers',
    );
    assertEqualOrThrow(
      formatTableRanges(['19-25', '2-6', '3']),
      '3, 2-6, 19-25',
      'non-numeric names stay as they are',
    );
    assertEqualOrThrow(
      formatTableRanges(['VIP 10', 'VIP 2']),
      'VIP 2, VIP 10',
      'other names sort naturally',
    );
    assertEqualOrThrow(formatTableRanges([]), '', 'no tables, no text');

    console.log('\n✅ All table staff assignment tests passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((error) => {
    try {
      closeDatabase();
    } catch {}
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
