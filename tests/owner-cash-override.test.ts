/**
 * Owner override for cash the shift gate refuses: owner PIN per action,
 * mandatory reason, audited, and post-close cash enters the next day's drawer.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-owner-cash-override-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-owner-cash-override';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { billRoutes } = require('../main/routes/bills');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const { printerRoutes } = require('../main/routes/printers');
const { resetPinRateLimitForTests } = require('../main/middleware/security');
const { assertEqualOrThrow, assertOrThrow, getResults } = require('./helpers/test-setup');

const RealDate = global.Date;
function freezeClock(iso: string): void {
  const fixedMs = RealDate.parse(iso);
  class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixedMs);
      else super(...(args as [any]));
    }
    static now(): number {
      return fixedMs;
    }
  }
  global.Date = FixedDate as DateConstructor;
}

function setSetting(db: any, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

let seq = 0;
function seedUnpaidBill(db: any, userId: string): number {
  seq += 1;
  const at = now();
  const orderId = Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
         VALUES (?, ?, 'takeaway', 'served', 100, 100, ?, ?)`,
      )
      .run(`ORD-OVR-${seq}`, userId, at, at).lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
         VALUES (?, ?, 100, 100, 0, 100, 'unpaid', '[]', ?, ?)`,
      )
      .run(`INV-OVR-${seq}`, orderId, at, at).lastInsertRowid,
  );
}

function insertUser(db: any, id: string, role: string, pin: string): void {
  db.prepare(
    `INSERT INTO users (id, name, email, password, pin_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    id,
    `${id}@test.local`,
    bcrypt.hashSync('pw', 4),
    bcrypt.hashSync(pin, 4),
    role,
    now(),
    now(),
  );
}

async function main() {
  initDatabase();
  const db = getDatabase();
  setSetting(db, 'country', 'TH');
  setSetting(db, 'currency', 'THB');
  setSetting(db, 'timezone', 'Asia/Bangkok');
  setSetting(db, 'business_day_start_time', '05:00');
  setSetting(db, 'require_open_shift', 'true');
  insertUser(db, 'owner-ovr', 'owner', '1234');
  insertUser(db, 'manager-ovr', 'manager', '5678');
  insertUser(db, 'cashier-ovr', 'cashier', '9999');
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, is_default, paper_width, created_at, updated_at)
     VALUES ('printer-ovr', 'Drawer', 'webusb', 1, '80mm', ?, ?)`,
  ).run(now(), now());

  const sign = (userId: string, role: string) =>
    jwt.sign({ userId, email: `${userId}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  const cashierToken = sign('cashier-ovr', 'cashier');
  const ownerToken = sign('owner-ovr', 'owner');

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.authorization) {
      req.user = jwt.verify(String(req.headers.authorization).split(' ')[1], getJWTSecret(), {
        ignoreExpiration: true,
      });
    }
    next();
  });
  app.use('/api/bills', billRoutes);
  app.use('/api/cash-closures', cashClosureRoutes);
  app.use('/api/printers', printerRoutes);

  let keySeq = 0;
  const payCash = (billId: number, extra: Record<string, unknown> = {}) =>
    request(app)
      .post(`/api/bills/${billId}/payments`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', `ovr-${++keySeq}`)
      .send({ payments: [{ method: 'cash', amount: 100 }], ...extra });
  const kick = (extra?: Record<string, unknown>) =>
    request(app)
      .post('/api/printers/kick-drawer')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(extra ?? {});
  const billRow = (id: number) => db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  const authAudit = (outcome: string) =>
    db
      .prepare(
        `SELECT * FROM auth_audit_log WHERE event_type = 'owner_cash_override' AND outcome = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(outcome);

  try {
    // 19:00 Bangkok on business date 2026-11-20, no shift open.
    freezeClock('2026-11-20T12:00:00.000Z');

    console.log('\n1. Without an override the gate still refuses cash');
    const bill1 = seedUnpaidBill(db, 'cashier-ovr');
    const refused = await payCash(bill1);
    assertEqualOrThrow(refused.status, 409, 'cash without a shift is refused');
    assertEqualOrThrow(
      refused.body?.display_code,
      'cash_session_required',
      'refusal names the shift',
    );

    console.log('\n2. Wrong PIN, manager PIN and missing reason are refused');
    const wrong = await payCash(bill1, {
      owner_override_pin: '0000',
      owner_override_reason: 'staff closed early',
    });
    assertEqualOrThrow(wrong.status, 403, 'wrong PIN is refused');
    assertEqualOrThrow(wrong.body?.display_code, 'owner_pin_invalid', 'refusal names the PIN');
    assertOrThrow(!!authAudit('failure'), 'a failed attempt is audited');
    const manager = await payCash(bill1, {
      owner_override_pin: '5678',
      owner_override_reason: 'staff closed early',
    });
    assertEqualOrThrow(manager.status, 403, 'a manager PIN cannot override');
    const noReason = await payCash(bill1, {
      owner_override_pin: '1234',
      owner_override_reason: ' ',
    });
    assertEqualOrThrow(
      noReason.body?.display_code,
      'owner_override_reason_required',
      'a reason is required',
    );
    assertEqualOrThrow(billRow(bill1).payment_status, 'unpaid', 'refused overrides record nothing');
    resetPinRateLimitForTests();

    console.log('\n3. Owner PIN lets one cash payment through and audits it');
    const allowed = await payCash(bill1, {
      owner_override_pin: '1234',
      owner_override_reason: 'shift not opened',
    });
    assertEqualOrThrow(allowed.status, 200, 'owner override settles the bill');
    const paid = billRow(bill1);
    assertEqualOrThrow(paid.payment_status, 'paid', 'bill is paid');
    assertOrThrow(
      !paid.payment_details.includes('owner_override'),
      'override fields are not stored on the payment',
    );
    const orderAudit = db
      .prepare(
        `SELECT details_json FROM order_audit_log WHERE action = 'owner_cash_override' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    const details = JSON.parse(orderAudit.details_json);
    assertEqualOrThrow(details.owner_user_id, 'owner-ovr', 'audit names the owner');
    assertEqualOrThrow(details.actor_user_id, 'cashier-ovr', 'audit names the staff member');
    assertEqualOrThrow(details.reason, 'shift not opened', 'audit keeps the reason');
    assertEqualOrThrow(
      details.blocked_by,
      'cash_session_required',
      'audit keeps what was bypassed',
    );
    assertEqualOrThrow(details.pay_in_business_date, undefined, 'an open day needs no carry-over');
    assertOrThrow(!!authAudit('success'), 'the used override is audited');

    console.log('\n4. The override covers one action only');
    const bill2 = seedUnpaidBill(db, 'cashier-ovr');
    const next = await payCash(bill2);
    assertEqualOrThrow(next.status, 409, 'the next cash payment needs its own override');

    console.log('\n5. Cash after day close enters the next business day drawer');
    db.prepare(
      `UPDATE orders SET status = 'cancelled' WHERE id = (SELECT order_id FROM bills WHERE id = ?)`,
    ).run(bill2);
    const closed = await request(app)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ business_date: '2026-11-20', opening_float_cents: 0, counted_cash_cents: 10000 });
    assertEqualOrThrow(closed.status, 201, 'the trading day closes');
    const closedExpected = closed.body.zReport.expected_cash_cents;
    freezeClock('2026-11-20T12:30:00.000Z');
    const lateBill = seedUnpaidBill(db, 'cashier-ovr');
    const lateRefused = await payCash(lateBill);
    assertEqualOrThrow(
      lateRefused.body?.display_code,
      'day_already_closed',
      'closed day refuses cash',
    );
    const late = await payCash(lateBill, {
      owner_override_pin: '1234',
      owner_override_reason: 'day closed by mistake',
    });
    assertEqualOrThrow(late.status, 200, 'owner override takes cash after close');
    const payIn = db
      .prepare(
        `SELECT * FROM cash_drawer_movements WHERE movement_type = 'pay_in' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    assertEqualOrThrow(
      payIn.business_date,
      '2026-11-21',
      'the cash is a pay-in on the next business date',
    );
    assertEqualOrThrow(payIn.amount_cents, 10000, 'the pay-in equals the cash taken');
    assertEqualOrThrow(payIn.created_by, 'owner-ovr', 'the pay-in is attributed to the owner');
    const storedZ = db
      .prepare(
        `SELECT expected_cash_cents FROM cash_closures WHERE business_date = '2026-11-20' AND scope = 'day'`,
      )
      .get();
    assertEqualOrThrow(storedZ.expected_cash_cents, closedExpected, 'the closed Z is unchanged');

    console.log('\n6. Drawer open without a shift needs the owner PIN');
    const kickRefused = await kick();
    assertEqualOrThrow(kickRefused.status, 409, 'drawer open without a shift is refused');
    assertEqualOrThrow(
      kickRefused.body?.error,
      'open_cash_shift_required',
      'refusal names the shift',
    );
    const kickWrong = await kick({
      owner_override_pin: '5678',
      owner_override_reason: 'need change',
    });
    assertEqualOrThrow(kickWrong.status, 403, 'a manager PIN cannot open the drawer');
    const kickAllowed = await kick({
      owner_override_pin: '1234',
      owner_override_reason: 'need change',
    });
    assertEqualOrThrow(kickAllowed.status, 200, 'owner PIN opens the drawer');
    const kickAudit = JSON.parse(authAudit('success').details_json);
    assertEqualOrThrow(kickAudit.action, 'drawer_kick', 'drawer open is audited');
    assertEqualOrThrow(kickAudit.reason, 'need change', 'drawer audit keeps the reason');

    console.log('\n7. Repeated wrong PINs lock the override out');
    resetPinRateLimitForTests();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      lastStatus = (await kick({ owner_override_pin: '0000', owner_override_reason: 'guessing' }))
        .status;
    }
    assertEqualOrThrow(lastStatus, 429, 'the PIN lockout applies');
    const lockedOut = await kick({ owner_override_pin: '1234', owner_override_reason: 'guessing' });
    assertEqualOrThrow(lockedOut.status, 429, 'even the right PIN waits out the lockout');
  } finally {
    global.Date = RealDate;
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { failed } = getResults();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  global.Date = RealDate;
  console.error(error);
  process.exit(1);
});
