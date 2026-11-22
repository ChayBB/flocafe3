/**
 * Guest bill request: a table-QR phone asks staff for the bill of its own table's order only.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/guest-bill-request.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-guest-bill-request-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedTable,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const {
  openGuestTableSession,
  addGuestDevice,
  closeGuestTableSession,
} = require('../main/lib/guest-table-session');
const { GUEST_USER_ID, guestTableOrder } = require('../main/lib/guest-order');
const { requestOrderBill } = require('../main/services/orders');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function main() {
  console.log('Guest bill request');
  console.log('='.repeat(60));
  process.env.SERVER_APP_PORT = String(await freePort());
  const db = initTestDb();
  const { startServerApp, stopServerApp, getServerAppPort } = require('../main/server-app');

  seedTable(db, 'tb-1', 1);
  seedTable(db, 'tb-2', 2);
  seedTable(db, 'tb-3', 3);
  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, table_id, type, status, total) VALUES (?, ?, 'dine_in', ?, 100)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status)
     VALUES (?, 'p', 'Fried rice', 100, 1, 100, 100, 'served')`,
  );
  const own = insertOrder.run('G-1', 'tb-1', 'served').lastInsertRowid;
  insertItem.run(own);
  const other = insertOrder.run('G-2', 'tb-2', 'pending').lastInsertRowid;
  insertItem.run(other);

  const ownDevice = addGuestDevice(db, openGuestTableSession(db, 'tb-1', null).id, 'slip');
  const otherDevice = addGuestDevice(db, openGuestTableSession(db, 'tb-2', null).id, 'slip');
  const emptyDevice = addGuestDevice(db, openGuestTableSession(db, 'tb-3', null).id, 'slip');

  await startServerApp();
  const base = `http://127.0.0.1:${getServerAppPort()}`;
  const ask = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/guest/bill-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const billState = (id: number | bigint) =>
    db
      .prepare(
        'SELECT bill_requested_at, bill_requested_by, bill_requested_by_name FROM orders WHERE id = ?',
      )
      .get(id) as {
      bill_requested_at: string | null;
      bill_requested_by: string | null;
      bill_requested_by_name: string | null;
    };
  const audits = (id: number | bigint) =>
    db
      .prepare(
        "SELECT actor_user_id FROM order_audit_log WHERE order_id = ? AND action = 'bill_requested'",
      )
      .all(id) as { actor_user_id: string }[];

  try {
    const missing = await ask({ table_id: 'tb-1' });
    assertEqualOrThrow(missing.status, 410, 'a request without a device token is refused');
    assertEqualOrThrow(billState(own).bill_requested_at, null, 'and nothing is marked');

    const crossTable = await ask({ table_id: 'tb-2', device_token: ownDevice });
    assertEqualOrThrow(crossTable.status, 410, "a phone cannot ask for another table's bill");
    assertEqualOrThrow(billState(other).bill_requested_at, null, 'the other table stays unbilled');

    const first = await ask({ table_id: 'tb-1', device_token: ownDevice });
    assertEqualOrThrow(first.status, 200, 'a phone asks for its own table bill');
    const state = billState(own);
    assertOrThrow(Boolean(state.bill_requested_at), 'the order now waits for payment');
    assertEqualOrThrow(
      first.body.bill_requested_at,
      state.bill_requested_at,
      'the time comes back',
    );
    assertEqualOrThrow(state.bill_requested_by, GUEST_USER_ID, 'the request is the guest’s');
    assertEqualOrThrow(state.bill_requested_by_name, 'Guest', 'staff see a guest asked');
    assertEqualOrThrow(
      audits(own)
        .map((row) => row.actor_user_id)
        .join(','),
      GUEST_USER_ID,
      'the audit names the guest, not a staff member',
    );
    const waiting = db
      .prepare(
        `SELECT id FROM orders WHERE bill_requested_at IS NOT NULL
          AND bill_payment_received_at IS NULL AND status NOT IN ('completed', 'cancelled')`,
      )
      .all() as { id: number }[];
    assertEqualOrThrow(
      waiting.map((row) => Number(row.id)).join(','),
      String(own),
      'the POS bill-request list now shows the table',
    );
    assertEqualOrThrow(
      guestTableOrder(db, 'tb-1')?.bill_requested_at,
      state.bill_requested_at,
      'the guest page sees its request after a reload',
    );

    const again = await ask({ table_id: 'tb-1', device_token: ownDevice });
    assertEqualOrThrow(again.status, 200, 'a second tap succeeds');
    assertEqualOrThrow(
      billState(own).bill_requested_at,
      state.bill_requested_at,
      'and keeps the first request time',
    );
    assertEqualOrThrow(audits(own).length, 1, 'and records no second request');

    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active)
       VALUES ('u-ann', 'Ann', 'ann@test.local', 'x', 'server', 1)`,
    ).run();
    requestOrderBill(db, own, 'u-ann');
    const answered = billState(own);
    assertEqualOrThrow(answered.bill_requested_by, 'u-ann', 'staff printing the bill answer it');
    assertEqualOrThrow(answered.bill_requested_by_name, 'Ann', 'so the alert leaves the phones');
    assertEqualOrThrow(
      answered.bill_requested_at,
      state.bill_requested_at,
      'and the wait keeps counting from the guest request',
    );
    assertEqualOrThrow(
      audits(own)
        .map((row) => row.actor_user_id)
        .join(','),
      `${GUEST_USER_ID},u-ann`,
      'the audit shows the guest asked and who brought the bill',
    );
    const repeatGuest = await ask({ table_id: 'tb-1', device_token: ownDevice });
    assertEqualOrThrow(repeatGuest.status, 200, 'a guest tap after staff answered is harmless');
    assertEqualOrThrow(
      billState(own).bill_requested_by,
      'u-ann',
      'and does not raise the alert again',
    );

    const noOrder = await ask({ table_id: 'tb-3', device_token: emptyDevice });
    assertEqualOrThrow(noOrder.status, 409, 'a table with nothing ordered has no bill to ask for');
    assertEqualOrThrow(noOrder.body.code, 'no_open_order', 'and says why');

    closeGuestTableSession(db, 'tb-2', null);
    const ended = await ask({ table_id: 'tb-2', device_token: otherDevice });
    assertEqualOrThrow(ended.status, 410, 'a phone from an ended session is refused');
    assertEqualOrThrow(billState(other).bill_requested_at, null, 'and marks nothing');
  } finally {
    await stopServerApp();
    closeDatabase();
    Module._load = originalLoad;
  }
  console.log('All guest bill request checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
