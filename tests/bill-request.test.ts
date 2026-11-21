/**
 * Bill requests: printing a table's bill from the Server App records who asked and when, the POS
 * lists the table as waiting for payment, and paying the last open bill stamps when it was received.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/bill-request.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-request-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-bill-request';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { billRequestRoutes } = require('../main/routes/bill-requests');
const { billRoutes } = require('../main/routes/bills');

function seedUser(db: any, id: string, name: string, role: string) {
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, `${id}@test.local`, bcrypt.hashSync('4821', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Bill requests');
  console.log('='.repeat(60));
  const db = initTestDb();
  const serverAuth = seedUser(db, 'server-bill', 'แมว', 'server');
  const cashierAuth = seedUser(db, 'cashier-bill', 'Cashier', 'cashier');
  db.prepare(
    "INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES ('tbl-26', '26', 4, 'occupied', ?, ?)",
  ).run(now(), now());
  db.prepare(`INSERT INTO orders (order_number, type, status, table_id, subtotal, tax_amount, total, created_at, updated_at)
    VALUES ('ORD-BILL-1', 'dine_in', 'served', 'tbl-26', 300, 0, 300, ?, ?)`).run(now(), now());
  const orderId = (
    db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-BILL-1'").get() as any
  ).id;

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bill-requests': billRequestRoutes,
    '/api/bills': billRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const orderRow = () => db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
  const pending = async () =>
    (await api(baseUrl, '/api/bill-requests', { headers: cashierAuth })).data.requests as any[];

  const insertItem =
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status, weight_pending, created_at, updated_at)
    VALUES (?, 'p-bill', ?, 1, 150, 150, 150, 'served', ?, ?, ?)`);
  const coffee = insertItem.run(orderId, 'Coffee', 0, now(), now()).lastInsertRowid;
  const fish = insertItem.run(orderId, 'Market fish', 1, now(), now()).lastInsertRowid;
  insertItem.run(orderId, 'Cancelled tea', 0, now(), now());
  db.prepare(
    "UPDATE order_items SET status = 'cancelled' WHERE product_name = 'Cancelled tea'",
  ).run();
  const billRequest = () =>
    api(baseUrl, `/api/orders/${orderId}/bill-request`, {
      method: 'POST',
      body: {},
      headers: serverAuth,
    });

  try {
    // The bill waits for every live item to be priced; service staff need not confirm serving first.
    db.prepare('UPDATE order_items SET served_confirmed_at = ? WHERE id IN (?, ?)').run(
      now(),
      coffee,
      fish,
    );
    const unpriced = await billRequest();
    assertEqualOrThrow(unpriced.status, 409, 'an item waiting for its price blocks the bill');
    assertEqualOrThrow(unpriced.data.code, 'weight_pending', 'the refusal says a price is missing');
    db.prepare(
      'UPDATE order_items SET weight_pending = 0, served_confirmed_at = NULL WHERE id = ?',
    ).run(fish);
    const request = await billRequest();
    assertEqualOrThrow(
      request.status,
      200,
      `a server asks for the bill before every dish is confirmed at the table (${JSON.stringify(request.data)})`,
    );
    const first = orderRow();
    assertOrThrow(Boolean(first.bill_requested_at), 'the request time is recorded');
    assertEqualOrThrow(
      first.bill_requested_by,
      'server-bill',
      'the requesting staff member is recorded',
    );
    assertEqualOrThrow(first.bill_requested_by_name, 'แมว', 'their name is kept for the POS');
    assertOrThrow(
      Boolean(
        db
          .prepare("SELECT 1 FROM order_audit_log WHERE order_id = ? AND action = 'bill_requested'")
          .get(String(orderId)),
      ),
      'the request is in the order audit log',
    );

    // A reprint keeps the first time, so the wait keeps counting from it.
    db.prepare('UPDATE orders SET bill_requested_at = ? WHERE id = ?').run(
      '2026-01-01 10:00:00',
      orderId,
    );
    await api(baseUrl, `/api/orders/${orderId}/bill-request`, {
      method: 'POST',
      body: {},
      headers: serverAuth,
    });
    assertEqualOrThrow(
      orderRow().bill_requested_at,
      '2026-01-01 10:00:00',
      'a reprint does not restart the wait',
    );

    const waiting = await pending();
    const listed = waiting.find((entry) => entry.id === orderId);
    assertOrThrow(Boolean(listed), 'the POS lists the table as waiting for payment');
    assertEqualOrThrow(listed.table_name, '26', 'the list names the table');
    assertEqualOrThrow(listed.bill_requested_by_name, 'แมว', 'the list names who asked');
    const forbidden = await api(baseUrl, '/api/bill-requests', { headers: serverAuth });
    assertEqualOrThrow(forbidden.status, 403, 'only staff who take payments see the list');
    const billRequestedIds = async () =>
      (
        (await api(baseUrl, '/api/orders?status=bill_requested', { headers: cashierAuth })).data
          .orders as any[]
      ).map((order) => order.id);
    assertOrThrow(
      (await billRequestedIds()).includes(orderId),
      'the orders list filters to tables whose bill is printed and unpaid',
    );

    // A printed bill closes the table to new food until the cashier receives the payment.
    db.prepare(
      `INSERT INTO categories (id, name, is_active, created_at, updated_at) VALUES ('cat-bill', 'Food', 1, ?, ?)`,
    ).run(now(), now());
    db.prepare(`INSERT INTO products (id, category_id, name, price, stock_quantity, is_active, created_at, updated_at)
      VALUES ('p-bill', 'cat-bill', 'Coffee', 150, 100, 1, ?, ?)`).run(now(), now());
    const addItem = (headers: Record<string, string>) =>
      api(baseUrl, `/api/orders/${orderId}/items`, {
        method: 'POST',
        body: { items: [{ product_id: 'p-bill', quantity: 1 }] },
        headers,
      });
    const lockedAdd = await addItem(serverAuth);
    assertEqualOrThrow(lockedAdd.status, 409, 'a server cannot add food once the bill is printed');
    assertEqualOrThrow(
      lockedAdd.data.code,
      'bill_awaiting_payment',
      'the refusal says the table waits for payment',
    );
    const lockedNew = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'dine_in', table_id: 'tbl-26', items: [{ product_id: 'p-bill', quantity: 1 }] },
      headers: serverAuth,
    });
    assertEqualOrThrow(
      lockedNew.status,
      409,
      'a server cannot start another order on the waiting table',
    );
    assertEqualOrThrow(
      lockedNew.data.code,
      'bill_awaiting_payment',
      'a new order is refused for the same reason',
    );
    const cashierAdd = await addItem(cashierAuth);
    assertOrThrow(
      cashierAdd.status < 300,
      `the cashier can still add to the bill (status ${cashierAdd.status})`,
    );

    // Two bills: paying one leaves the table waiting; paying the last stamps the receipt time.
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, payment_status, created_at, updated_at)
      VALUES ('B-1', ?, 150, 0, 150, 'unpaid', ?, ?), ('B-2', ?, 150, 0, 150, 'unpaid', ?, ?)`).run(
      orderId,
      now(),
      now(),
      orderId,
      now(),
      now(),
    );
    db.prepare(
      "UPDATE bills SET payment_status = 'paid', paid_at = '2026-01-01 10:03:00' WHERE bill_number = 'B-1'",
    ).run();
    assertEqualOrThrow(
      orderRow().bill_payment_received_at,
      null,
      'an open second bill keeps the table waiting',
    );
    db.prepare(
      "UPDATE bills SET payment_status = 'paid', paid_at = '2026-01-01 10:04:30' WHERE bill_number = 'B-2'",
    ).run();
    assertEqualOrThrow(
      orderRow().bill_payment_received_at,
      '2026-01-01 10:04:30',
      'paying the last bill stamps when money was received',
    );
    assertOrThrow(
      !(await pending()).some((entry) => entry.id === orderId),
      'a paid table leaves the waiting list',
    );
    assertOrThrow(
      !(await billRequestedIds()).includes(orderId),
      'and leaves the printed-bill filter',
    );
    const reopened = await addItem(serverAuth);
    assertOrThrow(
      reopened.status < 300,
      `the table takes orders again once paid (status ${reopened.status})`,
    );

    db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(orderId);
    const closed = await api(baseUrl, `/api/orders/${orderId}/bill-request`, {
      method: 'POST',
      body: {},
      headers: serverAuth,
    });
    assertEqualOrThrow(closed.status, 409, 'a closed order cannot ask for its bill');

    // The cashier prints the bill before taking the money: the table waits for confirmation,
    // and the confirmed payment names the cashier who received it.
    db.prepare(`INSERT INTO orders (order_number, type, status, table_id, subtotal, tax_amount, total, created_at, updated_at)
      VALUES ('ORD-BILL-2', 'dine_in', 'served', 'tbl-26', 150, 0, 150, ?, ?)`).run(now(), now());
    const cashierOrderId = (
      db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-BILL-2'").get() as any
    ).id;
    insertItem.run(cashierOrderId, 'Coffee', 0, now(), now());
    const cashierRequest = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
      api(baseUrl, `/api/orders/${cashierOrderId}/bill-request`, {
        method: 'POST',
        body: { cashier: true, ...extra },
        headers,
      });
    const cashierOrder = () =>
      db.prepare('SELECT * FROM orders WHERE id = ?').get(cashierOrderId) as any;
    const serverAsCashier = await cashierRequest(serverAuth);
    assertEqualOrThrow(
      serverAsCashier.status,
      403,
      'only staff who take payments print as cashier',
    );

    const preflight = await cashierRequest(cashierAuth, { preflight: true });
    assertEqualOrThrow(preflight.status, 200, 'the confirmed table may print');
    assertEqualOrThrow(cashierOrder().bill_requested_at, null, 'a preflight records nothing');
    assertEqualOrThrow(
      cashierOrder().serve_confirm_requested_at,
      null,
      'the table is not flagged for a serve confirmation',
    );
    const cashierPrint = await cashierRequest(cashierAuth);
    assertEqualOrThrow(cashierPrint.status, 200, 'the printed bill is recorded');
    const printed = cashierOrder();
    assertEqualOrThrow(printed.status, 'served', 'printing the bill does not close the order');
    assertEqualOrThrow(
      printed.bill_requested_by_name,
      'Cashier',
      'the printing cashier is recorded',
    );
    assertEqualOrThrow(printed.bill_payment_received_at, null, 'the bill waits for confirmation');

    const generated = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: cashierOrderId },
      headers: cashierAuth,
    });
    assertOrThrow(generated.status < 300, `the bill is generated (status ${generated.status})`);
    assertEqualOrThrow(
      generated.data.bill.payment_status,
      'unpaid',
      'a printed bill is still unpaid',
    );
    const paid = await api(baseUrl, `/api/bills/${generated.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'card', amount: generated.data.bill.total },
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      paid.status,
      200,
      `the cashier confirms the payment (status ${paid.status})`,
    );
    assertEqualOrThrow(paid.data.bill.payment_status, 'paid', 'the confirmed bill is paid');
    const lines = paid.data.bill.payment_details as any[];
    assertEqualOrThrow(
      lines[lines.length - 1].received_by_name,
      'Cashier',
      'the payment line names the cashier who received it',
    );
    assertOrThrow(
      Boolean(
        (
          db
            .prepare('SELECT bill_payment_received_at FROM orders WHERE id = ?')
            .get(cashierOrderId) as any
        ).bill_payment_received_at,
      ),
      'the confirmed payment ends the wait',
    );

    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
      VALUES ('ORD-BILL-3', 'takeaway', 'pending', 150, 0, 150, ?, ?)`).run(now(), now());
    const takeawayId = (
      db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-BILL-3'").get() as any
    ).id;
    insertItem.run(takeawayId, 'Coffee', 0, now(), now());
    const takeawayPrint = await api(baseUrl, `/api/orders/${takeawayId}/bill-request`, {
      method: 'POST',
      body: { cashier: true },
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      takeawayPrint.status,
      200,
      'a take-away bill prints without a table confirmation',
    );

    console.log('\nAll bill request checks passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
