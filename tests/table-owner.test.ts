/**
 * Table (area) owner: informational staff assignment that never gates orders.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/table-owner.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-table-owner-'));
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
  seedManagerUser,
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { tableRoutes } = require('../main/routes/tables');
const { orderRoutes } = require('../main/routes/orders');

async function main() {
  console.log('Table owner');
  console.log('='.repeat(60));
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('gone-1', 'Gone Staff', 'gone@test.local', 'x', 'cashier', 0, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO tables (id, number, capacity, status, is_active) VALUES ('tb-own', '1', 4, 'available', 1)`,
  ).run();
  seedCategory(db, 'own-cat', 'Menu');
  seedProduct(db, 'own-prod', 'own-cat', 'Coffee', 100);
  db.prepare(
    `INSERT INTO tables (id, number, capacity, status, is_active) VALUES ('tb-other', '2', 4, 'available', 1)`,
  ).run();
  const app = createApp({ '/api/tables': tableRoutes, '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  const setOwner = (userId: unknown, headers = owner.authHeader) =>
    api(baseUrl, '/api/tables/tb-own/owner', { method: 'PUT', headers, body: { user_id: userId } });

  try {
    const candidates = await api(baseUrl, '/api/tables/owner-candidates', {
      headers: owner.authHeader,
    });
    assertEqualOrThrow(candidates.status, 200, 'candidates are listed');
    const ids = candidates.data.staff.map((member: any) => member.id);
    assertOrThrow(ids.includes(manager.userId), 'active staff are offered');
    assertOrThrow(!ids.includes('gone-1'), 'inactive staff are not offered');

    const missing = await api(baseUrl, '/api/tables/nope/owner', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { user_id: manager.userId },
    });
    assertEqualOrThrow(missing.status, 404, 'unknown table is rejected');
    assertEqualOrThrow((await setOwner('nobody')).status, 400, 'unknown staff is rejected');
    assertEqualOrThrow((await setOwner('gone-1')).status, 400, 'inactive staff is rejected');
    assertEqualOrThrow((await setOwner(42)).status, 400, 'non-string id is rejected');

    const set = await setOwner(manager.userId);
    assertEqualOrThrow(set.status, 200, 'owner is assigned');
    assertEqualOrThrow(
      set.data.table.owner_user_id,
      manager.userId,
      'response carries the owner id',
    );
    assertEqualOrThrow(
      set.data.table.owner_name,
      'Test Manager',
      'response carries the owner name',
    );

    const list = await api(baseUrl, '/api/tables', { headers: owner.authHeader });
    const listed = list.data.tables.find((table: any) => table.id === 'tb-own');
    assertEqualOrThrow(listed.owner_name, 'Test Manager', 'the table list shows the owner');

    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tb-own',
        items: [{ product_id: 'own-prod', quantity: 1 }],
      },
    });
    assertEqualOrThrow(
      created.status,
      201,
      `dine-in order is created (${JSON.stringify(created.data).slice(0, 120)})`,
    );
    const orderId = created.data.order.id;
    const snapshot = () =>
      (db.prepare('SELECT table_owner_user_id AS id FROM orders WHERE id = ?').get(orderId) as any)
        .id;
    assertEqualOrThrow(snapshot(), manager.userId, 'the order records the table owner when opened');
    const fetched = await api(baseUrl, `/api/orders/${orderId}`, { headers: owner.authHeader });
    assertEqualOrThrow(
      fetched.data.order.table_owner_name,
      'Test Manager',
      'the order shows the owner name',
    );

    const cleared = await setOwner(null);
    assertEqualOrThrow(cleared.status, 200, 'owner can be cleared');
    assertEqualOrThrow(cleared.data.table.owner_name, null, 'cleared owner has no name');

    assertEqualOrThrow(
      snapshot(),
      manager.userId,
      'changing the table owner keeps the order record',
    );
    // One staff member, one zone: tables on different floors cannot share an owner.
    for (const [id, number, floor] of [
      ['tb-f1', 'F1', 'A'],
      ['tb-f2', 'F2', 'A'],
      ['tb-f3', 'F3', 'B'],
    ]) {
      db.prepare(
        "INSERT INTO tables (id, number, capacity, status, floor, is_active) VALUES (?, ?, 4, 'available', ?, 1)",
      ).run(id, number, floor);
    }
    const setOwnerOn = (tableId: string, userId: string) =>
      api(baseUrl, `/api/tables/${tableId}/owner`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { user_id: userId },
      });
    assertEqualOrThrow((await setOwnerOn('tb-f1', owner.userId)).status, 200, 'owner takes zone A');
    assertEqualOrThrow(
      (await setOwnerOn('tb-f2', owner.userId)).status,
      200,
      'owner can hold several tables in one zone',
    );
    const crossZone = await setOwnerOn('tb-f3', owner.userId);
    assertEqualOrThrow(crossZone.status, 409, 'owner cannot also take zone B');
    assertEqualOrThrow(crossZone.data.code, 'owner_in_other_zone', 'conflict is reported');
    assertEqualOrThrow(
      (await setOwnerOn('tb-f3', manager.userId)).status,
      200,
      'another staff member can take zone B',
    );
    const zonesView = await api(baseUrl, '/api/tables/owner-candidates', {
      headers: owner.authHeader,
    });
    const mine = zonesView.data.staff.find((member: any) => member.id === owner.userId);
    assertEqualOrThrow(
      JSON.stringify(mine.zones),
      JSON.stringify(['A']),
      'candidates report the zone each staff member owns',
    );
    // Daily rotation: moving the staff member releases their previous zone.
    const moved = await api(baseUrl, '/api/tables/tb-f3/owner', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { user_id: owner.userId, move: true },
    });
    assertEqualOrThrow(moved.status, 200, 'a staff member can be moved to a new zone');
    const ownerOfTable = (id: string) =>
      (db.prepare('SELECT owner_user_id AS o FROM tables WHERE id = ?').get(id) as any).o;
    assertEqualOrThrow(ownerOfTable('tb-f3'), owner.userId, 'the new zone has the staff member');
    assertEqualOrThrow(ownerOfTable('tb-f1'), null, 'the old zone is released (first table)');
    assertEqualOrThrow(ownerOfTable('tb-f2'), null, 'the old zone is released (second table)');
    assertEqualOrThrow(
      (await setOwnerOn('tb-f1', owner.userId)).status,
      409,
      'moving needs an explicit request',
    );
    assertEqualOrThrow(
      (
        await api(baseUrl, '/api/tables/tb-f1/owner', {
          method: 'PUT',
          headers: owner.authHeader,
          body: { user_id: manager.userId, move: true },
        })
      ).status,
      200,
      'the former zone owner can be reassigned too',
    );
    db.prepare("UPDATE tables SET owner_user_id = ? WHERE id IN ('tb-f1','tb-f2')").run(
      owner.userId,
    );
    db.prepare("UPDATE tables SET owner_user_id = ? WHERE id = 'tb-f3'").run(manager.userId);
    const moveTable = await api(baseUrl, '/api/tables/tb-f1', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { floor: 'B' },
    });
    assertEqualOrThrow(
      moveTable.status,
      409,
      'a table cannot move floors if its owner would span two zones',
    );
    assertEqualOrThrow(
      (
        await api(baseUrl, '/api/tables/tb-f3', {
          method: 'PUT',
          headers: owner.authHeader,
          body: { floor: 'B' },
        })
      ).status,
      200,
      'unchanged floor edits still work',
    );

    // Zone-level editor: one owner for every active table in the zone.
    const zoneOwner = (body: Record<string, unknown>) =>
      api(baseUrl, '/api/tables/zone-owner', { method: 'PUT', headers: owner.authHeader, body });
    assertEqualOrThrow(
      (await zoneOwner({ floor: 'Nowhere', user_id: owner.userId })).status,
      404,
      'unknown zone is rejected',
    );
    assertEqualOrThrow(
      (await zoneOwner({ floor: 7, user_id: null })).status,
      400,
      'non-string floor is rejected',
    );
    assertEqualOrThrow(
      (await zoneOwner({ floor: 'A', user_id: 'nobody' })).status,
      400,
      'unknown staff is rejected',
    );
    const zoneBlocked = await zoneOwner({ floor: 'A', user_id: manager.userId });
    assertEqualOrThrow(
      zoneBlocked.status,
      409,
      'a staff member holding zone B cannot take zone A without moving',
    );
    assertEqualOrThrow(zoneBlocked.data.code, 'owner_in_other_zone', 'zone conflict is reported');
    const zoneMoved = await zoneOwner({ floor: 'A', user_id: manager.userId, move: true });
    assertEqualOrThrow(zoneMoved.status, 200, 'moving a staff member takes the whole zone');
    assertEqualOrThrow(zoneMoved.data.updated, 2, 'every table in the zone is updated');
    assertEqualOrThrow(
      ownerOfTable('tb-f1'),
      manager.userId,
      'zone A first table follows the zone owner',
    );
    assertEqualOrThrow(
      ownerOfTable('tb-f2'),
      manager.userId,
      'zone A second table follows the zone owner',
    );
    assertEqualOrThrow(ownerOfTable('tb-f3'), null, 'the previous zone is released');
    assertEqualOrThrow(
      (await zoneOwner({ floor: 'A', user_id: null })).status,
      200,
      'a zone owner can be cleared',
    );
    assertEqualOrThrow(ownerOfTable('tb-f1'), null, 'clearing releases the zone');
    assertEqualOrThrow(
      (await zoneOwner({ floor: 'B', user_id: manager.userId })).status,
      200,
      'zone B takes the manager again',
    );
    // New zone with a table range: one batch creates every table, optionally with an owner.
    const batch = (body: Record<string, unknown>) =>
      api(baseUrl, '/api/tables/batch', { method: 'POST', headers: owner.authHeader, body });
    const rangeTables = ['19', '20', '21'].map((number) => ({ number }));
    assertEqualOrThrow(
      (await batch({ floor: 'R', tables: [] })).status,
      400,
      'an empty batch is rejected',
    );
    assertEqualOrThrow(
      (await batch({ floor: 'R', tables: [{ number: '19' }, { number: '19' }] })).status,
      400,
      'a table listed twice is rejected',
    );
    assertEqualOrThrow(
      (await batch({ floor: 'R', tables: [{ number: '19', capacity: 0 }] })).status,
      400,
      'an invalid capacity is rejected',
    );
    const clash = await batch({ floor: 'R', tables: [{ number: '19' }, { number: 'F1' }] });
    assertEqualOrThrow(clash.status, 400, 'an existing table name is rejected');
    assertEqualOrThrow(clash.data.table, 'F1', 'the clashing table is named');
    assertEqualOrThrow(
      (db.prepare("SELECT COUNT(*) AS n FROM tables WHERE number = '19'").get() as any).n,
      0,
      'a rejected batch creates nothing',
    );
    const busyOwner = await batch({
      floor: 'R',
      tables: rangeTables,
      owner_user_id: manager.userId,
    });
    assertEqualOrThrow(busyOwner.status, 409, 'an owner of another zone needs an explicit move');

    const made = await batch({
      floor: 'R',
      tables: [{ number: '19' }, { number: '20', capacity: 6 }, { number: '21', capacity: '' }],
      owner_user_id: manager.userId,
      move: true,
    });
    assertEqualOrThrow(
      made.status,
      201,
      `the batch creates the tables (${JSON.stringify(made.data).slice(0, 100)})`,
    );
    assertEqualOrThrow(made.data.tables.length, 3, 'all three tables exist');
    assertEqualOrThrow(
      made.data.tables.map((table: any) => table.capacity).join(','),
      '4,6,4',
      'a blank capacity takes the default',
    );
    assertEqualOrThrow(
      made.data.tables[0].owner_name,
      'Test Manager',
      'the zone owner is applied to every new table',
    );
    assertEqualOrThrow(
      ownerOfTable('tb-f3'),
      null,
      'moving the owner released their previous zone',
    );

    db.prepare("UPDATE tables SET owner_user_id = ? WHERE id = 'tb-f3'").run(manager.userId);
    assertEqualOrThrow(
      ownerOfTable('tb-f3'),
      manager.userId,
      'the manager owns zone B before removal',
    );
    db.prepare('DELETE FROM users WHERE id = ?').run(manager.userId);
    const afterDelete = await api(baseUrl, '/api/tables/tb-f3', { headers: owner.authHeader });
    assertEqualOrThrow(
      afterDelete.data.table.owner_user_id,
      null,
      'removing the staff member clears the owner',
    );
    db.prepare(
      `UPDATE tables SET floor = 'Old', position_x = 10, position_y = 20 WHERE id IN ('tb-own', 'tb-other')`,
    ).run();
    const rezone = (zones: unknown) =>
      api(baseUrl, '/api/tables/zones', {
        method: 'PUT',
        headers: owner.authHeader,
        body: { zones },
      });
    assertEqualOrThrow((await rezone([])).status, 400, 'an empty re-zone is rejected');
    assertEqualOrThrow(
      (
        await rezone([
          { name: 'A', table_ids: ['tb-own'] },
          { name: 'a', table_ids: ['tb-other'] },
        ])
      ).status,
      400,
      'zone names must be unique',
    );
    assertEqualOrThrow(
      (await rezone([{ name: 'A', table_ids: ['tb-own', 'tb-own'] }])).status,
      400,
      'a table cannot be listed twice',
    );
    const rezoned = await rezone([
      { name: '1-1', table_ids: ['tb-own'] },
      { name: 'Old', table_ids: ['tb-other'] },
    ]);
    assertEqualOrThrow(rezoned.status, 200, 're-zone succeeds');
    assertEqualOrThrow(rezoned.data.affected, 1, 'only the table whose zone changed is updated');
    const zoned = (id: string) =>
      db.prepare('SELECT floor, position_x FROM tables WHERE id = ?').get(id) as {
        floor: string;
        position_x: number | null;
      };
    assertEqualOrThrow(zoned('tb-own').floor, '1-1', 'the table moves to its new zone');
    assertEqualOrThrow(zoned('tb-own').position_x, null, 'a moved table leaves the old floor plan');
    assertEqualOrThrow(zoned('tb-other').position_x, 10, 'an unmoved table keeps its position');
    console.log('\nAll table owner checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
