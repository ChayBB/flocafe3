/**
 * A customer who joins after paying can still be attached to that paid order, so the visit counts in
 * their history, without repricing the order or touching its paid bills. Changing or removing a
 * member on a paid order, and any link on a cancelled order, stays blocked.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-member-after-payment.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-member-after-payment-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
  now,
  seedOwnerUser,
  seedCustomer,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');

let seq = 0;
function insertOrder(
  db: any,
  status: string,
  billStatus: string | null,
  customerId: string | null = null,
) {
  seq += 1;
  const orderId = Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, customer_id, type, status, subtotal, tax_amount, total, created_at, updated_at)
         VALUES (?, ?, 'takeaway', ?, 100, 0, 100, ?, ?)`,
      )
      .run(`MEM-${seq}`, customerId, status, now(), now()).lastInsertRowid,
  );
  if (billStatus) {
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, customer_id, subtotal, total, paid_amount, payment_status, created_at, updated_at)
       VALUES (?, ?, ?, 100, 100, ?, ?, ?, ?)`,
    ).run(
      `MEM-BILL-${seq}`,
      orderId,
      customerId,
      billStatus === 'paid' ? 100 : 0,
      billStatus,
      now(),
      now(),
    );
  }
  return orderId;
}

async function main() {
  console.log('Member after payment');
  console.log('='.repeat(60));
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const app = createApp({ '/api/orders': orderRoutes });
  seedCustomer(db, 'cust-late', 'Late Joiner', '0812345678');
  seedCustomer(db, 'cust-other', 'Other Member', '0898765432');

  const link = (orderId: number, customerId: string | null) =>
    request(app)
      .patch(`/api/orders/${orderId}/customer`)
      .set(owner.authHeader)
      .send({ customer_id: customerId });

  try {
    const paid = insertOrder(db, 'completed', 'paid');
    const billBefore = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(paid) as any;
    const res = await link(paid, 'cust-late');
    assertEqualOrThrow(res.status, 200, 'A paid order without a member accepts one');
    assertEqualOrThrow(
      res.body.order.customer?.id,
      'cust-late',
      'The response carries the attached member',
    );
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(paid) as any;
    assertEqualOrThrow(order.customer_id, 'cust-late', 'The order now belongs to the member');
    assertEqualOrThrow(order.total, 100, 'The paid total is not repriced');
    const billAfter = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(paid) as any;
    assertEqualOrThrow(
      JSON.stringify(billAfter),
      JSON.stringify(billBefore),
      'The paid bill is left exactly as it was',
    );
    const audit = db
      .prepare(
        "SELECT details_json FROM order_audit_log WHERE order_id = ? AND action = 'customer_updated'",
      )
      .get(paid) as any;
    assertOrThrow(Boolean(audit), 'Attaching the member is audited');
    assertEqualOrThrow(
      JSON.parse(audit.details_json).after_payment,
      true,
      'The audit marks the link as after payment',
    );

    const servedPaid = insertOrder(db, 'served', 'paid');
    assertEqualOrThrow(
      (await link(servedPaid, 'cust-late')).status,
      200,
      'A paid but not yet closed order accepts a member',
    );

    const partPaid = insertOrder(db, 'served', 'partial');
    db.prepare('UPDATE bills SET paid_amount = 40, balance = 60 WHERE order_id = ?').run(partPaid);
    assertEqualOrThrow(
      (await link(partPaid, 'cust-late')).status,
      409,
      'A part-paid order still owing money keeps the normal payment guard',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(partPaid) as any).customer_id,
      null,
      'The part-paid order is left without a member',
    );

    assertEqualOrThrow(
      (await link(paid, 'cust-other')).status,
      409,
      'A paid order cannot switch to another member',
    );
    assertEqualOrThrow((await link(paid, null)).status, 409, 'A paid order cannot drop its member');
    assertEqualOrThrow(
      (db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(paid) as any).customer_id,
      'cust-late',
      'Rejected changes leave the member in place',
    );

    const completedNoBill = insertOrder(db, 'completed', null);
    assertEqualOrThrow(
      (await link(completedNoBill, null)).status,
      409,
      'Unlinking nobody on a closed order is rejected',
    );

    const cancelled = insertOrder(db, 'cancelled', null);
    assertEqualOrThrow(
      (await link(cancelled, 'cust-late')).status,
      400,
      'A cancelled order never takes a member',
    );

    const unpaid = insertOrder(db, 'pending', 'unpaid');
    const open = await link(unpaid, 'cust-late');
    assertEqualOrThrow(open.status, 200, 'An unpaid order still links through the normal path');
    assertEqualOrThrow(
      (db.prepare('SELECT customer_id FROM bills WHERE order_id = ?').get(unpaid) as any)
        .customer_id,
      'cust-late',
      'The normal path still moves unpaid bills to the member',
    );
  } finally {
    closeDatabase();
  }
  console.log('All member-after-payment checks passed');
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
