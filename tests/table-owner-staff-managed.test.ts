/**
 * Staff-managed table assignment: the store lets each staff member choose the tables they look
 * after, without letting them take or clear tables another person owns.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/table-owner-staff-managed.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-owner-staff-managed-'));
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
  claimOwnTables,
  readTableOwnerAssignmentSettings,
  runTableOwnerAssignmentIfDue,
  saveTableStaffRoster,
} = require('../main/services/table-owner-rotation');

function addUser(db: any, id: string, role: string, active = 1) {
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
  ).run(id, id, `${id}@test.local`, role, active, now(), now());
}

function addTable(db: any, id: string, owner: string | null, backup: string | null = null) {
  db.prepare(
    `INSERT INTO tables (id, number, capacity, status, is_active, floor, owner_user_id, backup_user_id)
     VALUES (?, ?, 4, 'available', 1, 'Indoor', ?, ?)`,
  ).run(id, id.slice(1), owner, backup);
}

function owners(db: any): Record<string, string | null> {
  const rows = db.prepare('SELECT id, owner_user_id FROM tables ORDER BY id').all();
  return Object.fromEntries(rows.map((row: any) => [row.id, row.owner_user_id]));
}

async function main() {
  console.log('Staff-managed table assignment');
  console.log('='.repeat(60));
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  addUser(db, 'staff-a', 'server');
  addUser(db, 'staff-b', 'server');
  addUser(db, 'staff-gone', 'server', 0);
  addUser(db, 'cashier-1', 'cashier');
  addTable(db, 't1', 'staff-a');
  addTable(db, 't2', null, 'staff-a');
  addTable(db, 't3', null);
  addTable(db, 't4', 'staff-b');

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
  const putMode = (body: unknown, headers = owner.authHeader) =>
    api(baseUrl, '/api/tables/owner-assignment', {
      method: 'PUT',
      headers,
      body,
    });

  try {
    const refused = claimOwnTables(db, 'staff-a', { table_ids: ['t3'] });
    assertOrThrow(!refused.ok, 'staff cannot choose tables while the manager manages them');
    assertEqualOrThrow(refused.status, 403, 'manager-managed refusal is forbidden');
    assertEqualOrThrow(refused.code, 'STAFF_MANAGED_MODE_OFF', 'refusal names the mode');
    assertEqualOrThrow(owners(db).t3, null, 'refused claim changes nothing');

    const cashierSwitch = await putMode({ mode: 'staff_managed' }, cashierHeader);
    assertEqualOrThrow(cashierSwitch.status, 403, 'a cashier cannot change the assignment mode');
    assertEqualOrThrow(readTableOwnerAssignmentSettings(db).mode, 'manual', 'mode stays manual');

    const before = owners(db);
    const switched = await putMode({ mode: 'staff_managed' });
    assertEqualOrThrow(switched.status, 200, 'owner saves the staff-managed mode');
    assertEqualOrThrow(switched.data.mode, 'staff_managed', 'response echoes the new mode');
    assertEqualOrThrow(switched.data.changes, 0, 'switching to staff-managed reassigns nothing');
    assertEqualOrThrow(
      readTableOwnerAssignmentSettings(db).mode,
      'staff_managed',
      'staff-managed mode is stored',
    );
    assertEqualOrThrow(
      JSON.stringify(owners(db)),
      JSON.stringify(before),
      'existing owners survive the switch',
    );

    const claimed = claimOwnTables(db, 'staff-a', {
      table_ids: ['t1', 't2', 't3'],
    });
    assertOrThrow(claimed.ok, 'staff takes free tables and keeps their own');
    const afterClaim = owners(db);
    assertEqualOrThrow(afterClaim.t2, 'staff-a', 'free table t2 now belongs to staff-a');
    assertEqualOrThrow(afterClaim.t3, 'staff-a', 'free table t3 now belongs to staff-a');
    assertEqualOrThrow(
      db.prepare('SELECT backup_user_id FROM tables WHERE id = ?').get('t2').backup_user_id,
      null,
      'taking a table you back up clears you as its backup',
    );
    const audit = db
      .prepare("SELECT actor_user_id FROM table_owner_audit WHERE action = 'staff_claim'")
      .all();
    assertOrThrow(
      audit.length > 0 && audit.every((row: any) => row.actor_user_id === 'staff-a'),
      'every claim is audited against the staff member',
    );

    const steal = claimOwnTables(db, 'staff-a', { table_ids: ['t1', 't4'] });
    assertOrThrow(!steal.ok, 'staff cannot take a table another person owns');
    assertEqualOrThrow(steal.status, 409, 'taking an owned table is a conflict');
    assertEqualOrThrow(steal.code, 'TABLE_OWNED_BY_OTHER', 'conflict code names the owner clash');
    assertEqualOrThrow(owners(db).t4, 'staff-b', 'staff-b keeps t4');
    assertEqualOrThrow(owners(db).t2, 'staff-a', 'a refused claim drops nothing');

    const dropped = claimOwnTables(db, 'staff-a', { table_ids: ['t1'] });
    assertOrThrow(dropped.ok, 'staff drops tables they no longer want');
    const afterDrop = owners(db);
    assertEqualOrThrow(afterDrop.t2, null, 'dropped t2 is free again');
    assertEqualOrThrow(afterDrop.t3, null, 'dropped t3 is free again');
    assertEqualOrThrow(afterDrop.t4, 'staff-b', 'dropping your tables never clears others');

    const cleared = claimOwnTables(db, 'staff-a', { table_ids: [] });
    assertOrThrow(cleared.ok, 'staff may give up all their tables');
    assertEqualOrThrow(owners(db).t1, null, 't1 is free after clearing');
    assertEqualOrThrow(owners(db).t4, 'staff-b', 'clearing your tables leaves others alone');

    const inactive = claimOwnTables(db, 'staff-gone', { table_ids: ['t3'] });
    assertOrThrow(!inactive.ok && inactive.status === 403, 'inactive staff cannot claim tables');
    const unknown = claimOwnTables(db, 'staff-a', { table_ids: ['nope'] });
    assertOrThrow(!unknown.ok && unknown.code === 'TABLE_NOT_FOUND', 'unknown tables are refused');
    const malformed = claimOwnTables(db, 'staff-a', { table_ids: 't3' });
    assertOrThrow(
      !malformed.ok && malformed.code === 'STAFF_TABLES_INVALID',
      'table_ids must be a list',
    );

    const backupOf = (id: string) =>
      db.prepare('SELECT backup_user_id FROM tables WHERE id = ?').get(id).backup_user_id;
    await putMode({ mode: 'staff_managed', backup_enabled: false });
    const backupOff = claimOwnTables(db, 'staff-a', {
      table_ids: ['t1'],
      backup_table_ids: ['t4'],
    });
    assertOrThrow(
      !backupOff.ok && backupOff.code === 'TABLE_BACKUP_DISABLED',
      'backup tables are refused when the store does not use them',
    );
    assertEqualOrThrow(owners(db).t1, null, 'a refused backup claim takes no table either');
    await putMode({ mode: 'staff_managed', backup_enabled: true });
    const withBackup = claimOwnTables(db, 'staff-a', {
      table_ids: ['t1'],
      backup_table_ids: ['t4'],
    });
    assertOrThrow(withBackup.ok, 'staff choose their tables and their backup tables together');
    assertEqualOrThrow(owners(db).t1, 'staff-a', 'staff-a owns t1');
    assertEqualOrThrow(backupOf('t4'), 'staff-a', 'staff-a backs up t4');
    assertEqualOrThrow(owners(db).t4, 'staff-b', 'backing up a table keeps its owner');
    const overlap = claimOwnTables(db, 'staff-a', { table_ids: ['t1'], backup_table_ids: ['t1'] });
    assertOrThrow(
      !overlap.ok && overlap.code === 'STAFF_TABLES_OVERLAP',
      'a table cannot be both your table and your backup',
    );
    assertOrThrow(
      claimOwnTables(db, 'staff-b', { table_ids: ['t4'], backup_table_ids: ['t1'] }).ok,
      'staff-b backs up the free backup slot on t1',
    );
    const takenBackup = claimOwnTables(db, 'staff-a', { table_ids: [], backup_table_ids: ['t1'] });
    assertOrThrow(
      !takenBackup.ok && takenBackup.status === 409 && takenBackup.code === 'TABLE_BACKUP_TAKEN',
      'staff cannot take a backup slot another person holds',
    );
    assertEqualOrThrow(owners(db).t1, 'staff-a', 'a refused backup claim drops nothing');
    assertOrThrow(claimOwnTables(db, 'staff-a', { table_ids: ['t1'] }).ok, 'tables-only claim');
    assertEqualOrThrow(backupOf('t4'), 'staff-a', 'leaving out backup_table_ids keeps backups');
    assertOrThrow(
      claimOwnTables(db, 'staff-a', { table_ids: ['t1'], backup_table_ids: [] }).ok,
      'an empty backup list clears your backups',
    );
    assertEqualOrThrow(backupOf('t4'), null, 'staff-a no longer backs up t4');
    assertEqualOrThrow(backupOf('t1'), 'staff-b', "clearing your backups leaves others' alone");
    await putMode({ mode: 'staff_managed', backup_enabled: false });

    const steady = owners(db);
    db.prepare("UPDATE settings SET value = '2000-01-01' WHERE key = ?").run(
      'table_owner_assignment_last_run',
    );
    const run = runTableOwnerAssignmentIfDue(db);
    assertEqualOrThrow(run.ran, false, 'the daily job never reassigns in staff-managed mode');
    saveTableStaffRoster(db, { presentIds: new Set(['staff-a']), tableCount: null }, 'owner');
    assertEqualOrThrow(
      JSON.stringify(owners(db)),
      JSON.stringify(steady),
      'saving the roster keeps staff choices',
    );

    await putMode({ mode: 'manual' });
    const offAgain = claimOwnTables(db, 'staff-a', { table_ids: ['t3'] });
    assertOrThrow(!offAgain.ok, 'leaving staff-managed mode stops staff claims');

    console.log('\n✅ All staff-managed table assignment tests passed');
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
