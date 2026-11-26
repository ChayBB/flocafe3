/**
 * Staff plans: a saved table assignment the manager can reuse. Applying restores the planned main
 * and backup staff, covers absent people with the zone rule, opens or closes festival tables, and
 * an automatic plan assigns from who is working.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/table-staff-plans.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-staff-plans-'));
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
const { saveTableStaffRoster } = require('../main/services/table-owner-rotation');
const { suggestTableStaffPlan, validatePlanInput } = require('../main/services/table-staff-plans');

interface Row {
  id: string;
  floor: string;
  is_active: number;
  owner_user_id: string | null;
  backup_user_id: string | null;
}

function addUser(db: any, id: string, partTime = 0) {
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, part_time, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'server', 1, ?, ?, ?)`,
  ).run(id, id, `${id}@test.local`, partTime, now(), now());
}

function addTable(db: any, id: string, floor: string, active = 1) {
  db.prepare(
    `INSERT INTO tables (id, number, capacity, status, is_active, floor)
     VALUES (?, ?, 4, 'available', ?, ?)`,
  ).run(id, id.slice(1), active, floor);
}

function rows(db: any): Record<string, Row> {
  const list = db
    .prepare('SELECT id, floor, is_active, owner_user_id, backup_user_id FROM tables')
    .all() as Row[];
  return Object.fromEntries(list.map((row) => [row.id, row]));
}

function setStaff(db: any, assignment: Record<string, [string | null, string | null]>) {
  for (const [id, [owner, backup]] of Object.entries(assignment)) {
    db.prepare('UPDATE tables SET owner_user_id = ?, backup_user_id = ? WHERE id = ?').run(
      owner,
      backup,
      id,
    );
  }
}

function checkZoneBackups(db: any, label: string) {
  const zones = new Map<string, Row[]>();
  for (const row of Object.values(rows(db))) {
    if (row.is_active !== 1) continue;
    zones.set(row.floor, [...(zones.get(row.floor) ?? []), row]);
  }
  for (const [zone, list] of zones) {
    const mains = new Set(list.map((row) => row.owner_user_id));
    assertOrThrow(
      list.every((row) => row.owner_user_id),
      `${label}: every table in zone ${zone} has a main staff member`,
    );
    assertOrThrow(
      list.every((row) => row.backup_user_id && !mains.has(row.backup_user_id)),
      `${label}: zone ${zone} backups are never its own main staff`,
    );
  }
}

async function main() {
  console.log('Staff plans');
  console.log('='.repeat(60));
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  for (const id of ['s1', 's2', 's3', 's4']) addUser(db, id);
  addUser(db, 'pt1', 1);
  addTable(db, 't1', 'Z1');
  addTable(db, 't2', 'Z1');
  addTable(db, 't3', 'Z2');
  addTable(db, 't4', 'Z2');
  addTable(db, 't5', 'Z3');
  addTable(db, 't6', 'Z3');
  addTable(db, 't7', 'Fest', 0);
  addTable(db, 't8', 'Fest', 0);
  const everyone = ['s1', 's2', 's3', 's4', 'pt1'];
  const attend = (ids: string[]) =>
    saveTableStaffRoster(db, { presentIds: new Set(ids), tableCount: null }, owner.userId);

  const app = createApp({ '/api/tables': tableRoutes });
  const { baseUrl, server } = await startServer(app);
  const call = (route: string, method = 'GET', body?: unknown) =>
    api(baseUrl, `/api/tables/staff-plans${route}`, { method, headers: owner.authHeader, body });

  try {
    assertOrThrow(!validatePlanInput({ name: '' }).ok, 'a plan needs a name');
    assertOrThrow(
      !validatePlanInput({ name: 'A', staff_min: 5, staff_max: 3 }).ok,
      'minimum staff cannot exceed maximum',
    );
    assertOrThrow(!validatePlanInput({ name: 'A', staff_min: 1.5 }).ok, 'staff counts are whole');
    assertEqualOrThrow((await call('', 'POST', { name: '' })).status, 400, 'API refuses no name');

    attend(['s1', 's2', 's3']);
    setStaff(db, {
      t1: ['s1', 's2'],
      t2: ['s1', 's2'],
      t3: ['s2', 's3'],
      t4: ['s2', 's3'],
      t5: ['s3', 's1'],
      t6: ['s3', 's1'],
    });
    const createdA = await call('', 'POST', { name: 'Full', staff_min: 3, staff_max: 3 });
    assertEqualOrThrow(createdA.status, 201, 'plan A is saved from the current assignment');
    const planA = createdA.data.plans.find((plan: any) => plan.id === createdA.data.plan_id);
    assertEqualOrThrow(planA.letter, 'A', 'the first plan is A');
    assertEqualOrThrow(planA.table_count, 6, 'plan A records the 6 open tables');
    assertEqualOrThrow(planA.zone_count, 3, 'plan A covers 3 zones');
    assertEqualOrThrow(createdA.data.suggested_plan_id, planA.id, '3 working suggests plan A');

    db.prepare('UPDATE tables SET is_active = 1 WHERE floor = ?').run('Fest');
    setStaff(db, {
      t1: ['s1', 's2'],
      t2: ['s1', 's2'],
      t3: ['s2', 's3'],
      t4: ['s2', 's3'],
      t5: ['s3', 'pt1'],
      t6: ['s3', 'pt1'],
      t7: ['pt1', 's1'],
      t8: ['pt1', 's1'],
    });
    attend(everyone);
    const createdC = await call('', 'POST', {
      name: 'Festival',
      staff_min: 5,
      staff_max: 8,
      condition_note: 'Songkran',
    });
    const planC = createdC.data.plans.find((plan: any) => plan.id === createdC.data.plan_id);
    assertEqualOrThrow(planC.letter, 'B', 'the second plan takes the next letter');
    assertEqualOrThrow(planC.table_count, 8, 'the festival plan keeps the festival tables open');
    assertEqualOrThrow(
      planC.people.filter((person: any) => person.part_time).length,
      1,
      'the festival plan lists its part-time staff',
    );
    assertEqualOrThrow(
      createdC.data.suggested_plan_id,
      planC.id,
      '5 working suggests the festival',
    );

    const createdD = await call('', 'POST', {
      name: 'Emergency',
      staff_min: 0,
      staff_max: 10,
      auto_assign: true,
    });
    const planD = createdD.data.plans.find((plan: any) => plan.id === createdD.data.plan_id);
    assertEqualOrThrow(planD.people.length, 0, 'the automatic plan locks no people');
    assertEqualOrThrow(
      createdD.data.suggested_plan_id,
      planC.id,
      'a people plan wins over the wider automatic plan',
    );

    attend(['s1', 's2', 's3']);
    const appliedA = await call(`/${planA.id}/apply`, 'POST');
    assertEqualOrThrow(appliedA.status, 200, 'plan A applies');
    let now1 = rows(db);
    assertEqualOrThrow(now1.t7.is_active, 0, 'switching to plan A closes festival table t7');
    assertEqualOrThrow(now1.t8.is_active, 0, 'switching to plan A closes festival table t8');
    assertEqualOrThrow(
      appliedA.data.deactivated_tables.sort().join(','),
      '7,8',
      'the result names the closed tables',
    );
    assertEqualOrThrow(now1.t1.owner_user_id, 's1', 'plan A restores t1 main');
    assertEqualOrThrow(now1.t5.backup_user_id, 's1', 'plan A restores t5 backup');
    assertEqualOrThrow(appliedA.data.absent.length, 0, 'nobody in plan A is absent');
    assertEqualOrThrow(
      db.prepare("SELECT COUNT(*) AS n FROM tables WHERE floor = 'Fest'").get().n,
      2,
      'festival tables are never deleted',
    );

    db.prepare(
      `INSERT INTO orders (order_number, table_id, type, subtotal, tax_amount, total, status, created_at, updated_at)
       VALUES ('P-1', 't7', 'dine_in', 0, 0, 0, 'pending', ?, ?)`,
    ).run(now(), now());
    attend(['s1', 's3', 's4', 'pt1']);
    const appliedC = await call(`/${planC.id}/apply`, 'POST');
    now1 = rows(db);
    assertEqualOrThrow(now1.t7.is_active, 1, 'plan C opens festival table t7');
    assertEqualOrThrow(
      appliedC.data.activated_tables.sort().join(','),
      '7,8',
      'the result names the opened tables',
    );
    assertEqualOrThrow(
      appliedC.data.absent.map((person: any) => person.id).join(','),
      's2',
      'the result names who is absent',
    );
    assertEqualOrThrow(now1.t3.owner_user_id, 's4', 'the free person s4 covers the absent main');
    assertEqualOrThrow(now1.t4.owner_user_id, 's4', 'the gap is covered as one run');
    assertOrThrow(appliedC.data.filled_tables.includes('3'), 'the result lists covered tables');
    checkZoneBackups(db, 'plan C with one absent');

    attend(['s1', 's3', 'pt1']);
    await call(`/${planA.id}/apply`, 'POST');
    const appliedC2 = await call(`/${planC.id}/apply`, 'POST');
    now1 = rows(db);
    assertEqualOrThrow(now1.t7.is_active, 1, 'reapplying plan C reopens t7');
    assertOrThrow(
      ['s1', 's3', 'pt1'].includes(now1.t3.owner_user_id as string),
      'with no free staff, an absent main is covered by someone working',
    );
    checkZoneBackups(db, 'plan C with no free staff');
    assertOrThrow(appliedC2.data.changes.length > 0, 'the result counts the changes');

    attend(['s1', 's2']);
    const appliedA2 = await call(`/${planA.id}/apply`, 'POST');
    assertEqualOrThrow(
      appliedA2.data.busy_tables.join(','),
      '7',
      'a festival table with an open order stays open',
    );
    assertEqualOrThrow(rows(db).t7.is_active, 1, 'the busy table is still open');
    assertEqualOrThrow(rows(db).t8.is_active, 0, 'the free festival table closes');
    assertEqualOrThrow(rows(db).t5.owner_user_id, 's1', 'absent s3 hands t5 to its backup s1');
    db.prepare("UPDATE orders SET status = 'completed' WHERE order_number = 'P-1'").run();

    attend(['s2', 's4']);
    const appliedD = await call(`/${planD.id}/apply`, 'POST');
    assertEqualOrThrow(appliedD.status, 200, 'the automatic plan applies');
    const active = Object.values(rows(db)).filter((row) => row.is_active === 1);
    assertOrThrow(
      active.every((row) => ['s2', 's4'].includes(row.owner_user_id as string)),
      'the automatic plan assigns only people who are working',
    );
    checkZoneBackups(db, 'automatic plan');

    const dup = await call(`/${planA.id}/duplicate`, 'POST');
    assertEqualOrThrow(dup.status, 201, 'a plan can be duplicated');
    const copy = dup.data.plans.find((plan: any) => plan.id === dup.data.plan_id);
    assertEqualOrThrow(copy.letter, 'D', 'the copy takes the next free letter');
    assertEqualOrThrow(copy.table_count, planA.table_count, 'the copy keeps the tables');

    const renamed = await call(`/${copy.id}`, 'PUT', {
      name: 'Short one',
      staff_min: 2,
      staff_max: 2,
      resnapshot: true,
    });
    assertEqualOrThrow(renamed.status, 200, 'a plan can be renamed and resaved');
    const resaved = renamed.data.plans.find((plan: any) => plan.id === copy.id);
    assertEqualOrThrow(resaved.name, 'Short one', 'the new name is stored');
    assertEqualOrThrow(
      resaved.people
        .map((person: any) => person.id)
        .sort()
        .join(','),
      's2,s4',
      'resaving takes the current assignment',
    );
    attend(['s2', 's4']);
    assertEqualOrThrow(
      (await call('')).data.suggested_plan_id,
      copy.id,
      '2 working suggests the exact 2-person plan',
    );

    assertEqualOrThrow((await call(`/${copy.id}`, 'DELETE')).status, 200, 'a plan is deleted');
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM table_staff_plan_tables WHERE plan_id = ?').get(copy.id)
        .n,
      0,
      'deleting a plan removes its saved tables',
    );
    assertEqualOrThrow((await call('/nope/apply', 'POST')).status, 404, 'unknown plan is 404');
    assertEqualOrThrow(suggestTableStaffPlan([], 3), null, 'no plans means no suggestion');

    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES ('cash1', 'cash1', 'cash1@test.local', 'x', 'cashier', 1, ?, ?)`,
    ).run(now(), now());
    const { getJWTSecret } = require('../main/routes/auth');
    const cashierToken = require('jsonwebtoken').sign(
      { userId: 'cash1', email: 'cash1@test.local', role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    const refused = await api(baseUrl, `/api/tables/staff-plans/${planA.id}/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
    });
    assertEqualOrThrow(refused.status, 403, 'only managers apply plans');

    console.log('\n✅ All staff plan tests passed');
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
