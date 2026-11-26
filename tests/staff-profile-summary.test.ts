/**
 * Staff profile "today" summary: a staff member's sales and bills count the orders they took or
 * whose table they owned, and new customers are customers whose first-ever order is today.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/staff-profile-summary.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-staff-profile-summary-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assertEqualOrThrow, closeDatabase } = require('./helpers/test-setup');
const { staffDaySummary } = require('../main/lib/staff-profile-summary');

const START = '2026-11-25 23:00:00';
const END = '2026-11-26 23:00:00';
const TODAY = '2026-11-26 09:30:00';
const YESTERDAY = '2026-11-25 12:00:00';

let seq = 0;
function addOrder(
  db: any,
  opts: {
    taker?: string | null;
    owner?: string | null;
    customer?: string;
    at?: string;
    status?: string;
  },
) {
  seq += 1;
  const at = opts.at ?? TODAY;
  return Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, type, status, user_id, table_owner_user_id, customer_id, created_at, updated_at)
         VALUES (?, 'dine_in', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `S-${seq}`,
        opts.status ?? 'completed',
        opts.taker ?? null,
        opts.owner ?? null,
        opts.customer ?? null,
        at,
        at,
      ).lastInsertRowid,
  );
}

function addBill(db: any, orderId: number, amount: number, paidAt: string | null, status = 'paid') {
  seq += 1;
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, total, paid_amount, payment_status, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`B-${seq}`, orderId, amount, amount, status, paidAt, TODAY, TODAY);
}

function main() {
  console.log('Staff profile summary');
  console.log('='.repeat(60));
  const db = initTestDb();
  for (const id of ['amy', 'ben']) {
    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'server', 1, ?, ?)`,
    ).run(id, id, `${id}@test.local`, TODAY, TODAY);
  }
  for (const id of ['c-new', 'c-old', 'c-ben']) {
    db.prepare(`INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
      id,
      id,
      TODAY,
      TODAY,
    );
  }

  // Amy took this order on a table nobody owned: it is hers even without a table owner.
  addBill(db, addOrder(db, { taker: 'amy', customer: 'c-new' }), 120, TODAY);
  // Ben took the order on Amy's table: both of them count it in their own summaries.
  addBill(db, addOrder(db, { taker: 'ben', owner: 'amy', customer: 'c-old' }), 80, TODAY);
  addOrder(db, { taker: 'ben', customer: 'c-old', at: YESTERDAY });
  // A guest QR order on Amy's table has no taker.
  addBill(db, addOrder(db, { owner: 'amy' }), 50, TODAY);
  // Not today, not paid, or someone else's: excluded from Amy's summary.
  addBill(db, addOrder(db, { taker: 'amy', at: YESTERDAY }), 999, YESTERDAY);
  addBill(db, addOrder(db, { taker: 'amy' }), 999, null, 'unpaid');
  addBill(db, addOrder(db, { taker: 'ben', customer: 'c-ben' }), 300, TODAY);
  // A cancelled first visit does not make an earlier order for that customer.
  addOrder(db, { taker: 'amy', customer: 'c-new', at: YESTERDAY, status: 'cancelled' });

  assertEqualOrThrow(
    JSON.stringify(staffDaySummary(db, 'amy', START, END)),
    JSON.stringify({ sales: 250, bills: 3, new_customers: 1 }),
    'Amy counts orders she took and orders on her tables; c-old visited yesterday',
  );
  assertEqualOrThrow(
    JSON.stringify(staffDaySummary(db, 'ben', START, END)),
    JSON.stringify({ sales: 380, bills: 2, new_customers: 1 }),
    'Ben counts the order he took on Amy’s table and his own new customer',
  );
  assertEqualOrThrow(
    JSON.stringify(staffDaySummary(db, 'nobody', START, END)),
    JSON.stringify({ sales: 0, bills: 0, new_customers: 0 }),
    'A staff member with no orders has an empty summary',
  );

  closeDatabase();
  console.log('All staff profile summary checks passed.');
}

main();
