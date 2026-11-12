/**
 * Day close is refused while the current business day is still trading, and
 * the cash gate reports a closed day instead of asking for a shift that the
 * closed day would refuse to open.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-day-close-open-trade-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-day-close-open-trade';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const { cashSessionRoutes } = require('../main/routes/cash-sessions');
const { billRoutes } = require('../main/routes/bills');
const { reportRoutes } = require('../main/routes/reports');
const {
  shiftUnpaidBillsInWindow,
  openTradeBlockingDayClose,
} = require('../main/services/cash-day-close-guards');
const { businessDateForInstant, dayBoundsInTimezone } = require('../shared/business-date');
const { Worker } = require('node:worker_threads');
const { requireOpenSessionForCashTender } = require('../main/services/shift-session-gate');
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

let orderSeq = 0;
function insertOrder(db: any, userId: string, status: string, createdAt: string): number {
  orderSeq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
         VALUES (?, ?, 'dine_in', ?, 100, 100, ?, ?)`,
      )
      .run(`ORD-T-${orderSeq}`, userId, status, createdAt, createdAt).lastInsertRowid,
  );
}

function insertBill(db: any, orderId: number, paymentStatus: string, createdAt: string): number {
  const paid = paymentStatus === 'paid';
  return Number(
    db
      .prepare(
        `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, paid_at, created_at, updated_at)
         VALUES (?, ?, 100, 100, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `INV-T-${orderId}`,
        orderId,
        paid ? 100 : 0,
        paid ? 0 : 100,
        paymentStatus,
        paid ? createdAt : null,
        createdAt,
        createdAt,
      ).lastInsertRowid,
  );
}

function gateCode(db: any, method: string): string | null {
  try {
    requireOpenSessionForCashTender(db, [{ method }], 'owner-trade');
    return null;
  } catch (error: any) {
    return error.diagnosticCode ?? 'unknown';
  }
}

async function main() {
  initDatabase();
  const db = getDatabase();
  setSetting(db, 'country', 'TH');
  setSetting(db, 'currency', 'THB');
  setSetting(db, 'timezone', 'Asia/Bangkok');
  setSetting(db, 'business_day_start_time', '00:00');

  const ownerId = 'owner-trade';
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, 'Owner', 'owner-trade@test.local', ?, 'owner', 1, ?, ?)`,
  ).run(ownerId, bcrypt.hashSync('pw', 4), now(), now());
  const token = jwt.sign(
    { userId: ownerId, email: 'owner-trade@test.local', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );

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
  app.use('/api/cash-closures', cashClosureRoutes);
  app.use('/api/cash-sessions', cashSessionRoutes);
  app.use('/api/bills', billRoutes);
  app.use('/api/reports', reportRoutes);
  const closeDay = (businessDate: string, countedCashCents = 0) =>
    request(app).post('/api/cash-closures').set('Authorization', `Bearer ${token}`).send({
      business_date: businessDate,
      opening_float_cents: 0,
      counted_cash_cents: countedCashCents,
    });
  const defaultCloseDate = () =>
    request(app).get('/api/cash-closures/default-date').set('Authorization', `Bearer ${token}`);

  try {
    console.log('\n1. Current business day with an after-midnight unpaid bill cannot close');
    // 08:41 Bangkok on 2026-11-12; the bill was opened at 02:44 the same local day.
    freezeClock('2026-11-12T01:41:00.000Z');
    const unpaidOrder = insertOrder(db, ownerId, 'ready', '2026-11-11 19:44:07');
    const unpaidBill = insertBill(db, unpaidOrder, 'unpaid', '2026-11-11 19:44:07');
    const unbilledOrder = insertOrder(db, ownerId, 'pending', '2026-11-12 01:00:00');
    // Paid orders left at `served` are not open trade.
    const servedPaid = insertOrder(db, ownerId, 'served', '2026-11-12 00:30:00');
    insertBill(db, servedPaid, 'paid', '2026-11-12 00:30:00');

    const blocked = await closeDay('2026-11-12');
    assertEqualOrThrow(blocked.status, 409, 'open trade blocks closing the current day');
    assertEqualOrThrow(
      blocked.body?.display_code,
      'open_trade_blocks_day_close',
      'refusal names open trade',
    );
    assertEqualOrThrow(blocked.body?.blocking_trade?.unpaid_bill_count, 1, 'one unpaid bill');
    assertEqualOrThrow(
      blocked.body?.blocking_trade?.unbilled_order_count,
      1,
      'one active order without a bill',
    );

    console.log('\n2. A past business day closes even with leftover unpaid bills');
    const pastOrder = insertOrder(db, ownerId, 'pending', '2026-11-11 05:00:00');
    insertBill(db, pastOrder, 'unpaid', '2026-11-11 05:00:00');
    const pastClose = await closeDay('2026-11-11');
    assertEqualOrThrow(pastClose.status, 201, 'past day is not gated on open trade');

    console.log('\n3. Once settled, the current day closes');
    db.prepare(
      `UPDATE bills SET payment_status = 'paid', paid_amount = total, balance = 0 WHERE id = ?`,
    ).run(unpaidBill);
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(unbilledOrder);
    const closed = await closeDay('2026-11-12');
    assertEqualOrThrow(closed.status, 201, 'settled day closes');

    console.log('\n4. Cash gate on a closed day says the day is closed');
    setSetting(db, 'require_open_shift', 'true');
    assertEqualOrThrow(gateCode(db, 'cash'), 'day_already_closed', 'cash refused as day closed');
    assertEqualOrThrow(gateCode(db, 'card'), null, 'non-cash is never gated');
    freezeClock('2026-11-13T01:00:00.000Z');
    assertEqualOrThrow(
      gateCode(db, 'cash'),
      'cash_session_required',
      'open day without a shift still asks for a shift',
    );

    console.log('\n5. Business day start time moves after-midnight bills to the prior day');
    setSetting(db, 'business_day_start_time', '05:00');
    // 02:30 Bangkok on 2026-11-14 is still business day 2026-11-13 with a 05:00 start.
    freezeClock('2026-11-13T19:30:00.000Z');
    const lateOrder = insertOrder(db, ownerId, 'ready', '2026-11-13 19:00:00');
    insertBill(db, lateOrder, 'unpaid', '2026-11-13 19:00:00');
    const lateBlocked = await closeDay('2026-11-13');
    assertEqualOrThrow(lateBlocked.status, 409, 'late-night bill keeps the prior day open');
    assertOrThrow(
      lateBlocked.body?.blocking_trade?.unpaid_bill_count === 1,
      'late-night bill counts toward the prior business day',
    );

    console.log(
      '\n6. Day windows exclude the next cutoff while shift previews include their as-of second',
    );
    const boundaryOrder = insertOrder(db, ownerId, 'ready', '2026-11-14 22:00:00');
    insertBill(db, boundaryOrder, 'unpaid', '2026-11-14 22:00:00');
    assertEqualOrThrow(
      openTradeBlockingDayClose(db, '2026-11-13 22:00:00', '2026-11-14 22:00:00'),
      null,
      'a bill at exactly the next 05:00 cutoff does not belong to the preceding day',
    );
    assertEqualOrThrow(
      shiftUnpaidBillsInWindow(db, '2026-11-14 21:00:00', '2026-11-14 22:00:00').bill_count,
      1,
      'the shift preview still includes a bill created in the as-of second',
    );
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(boundaryOrder);

    console.log('\n7. Bangkok 17:00-03:00 trading closes the previous date at 03:30');
    const toSql = (iso: string) => new RealDate(iso).toISOString().replace('T', ' ').slice(0, 19);
    for (const local of [
      '2026-11-15T17:00:00+07:00',
      '2026-11-15T23:59:59+07:00',
      '2026-11-16T00:00:00+07:00',
      '2026-11-16T03:30:00+07:00',
      '2026-11-16T04:59:59+07:00',
    ]) {
      assertEqualOrThrow(
        businessDateForInstant({
          instant: new RealDate(local),
          timezone: 'Asia/Bangkok',
          startTime: '05:00',
        }),
        '2026-11-15',
        `${local} belongs to the opening business date`,
      );
    }
    const openShift = (float = 0) =>
      request(app)
        .post('/api/cash-sessions/open')
        .set('Authorization', `Bearer ${token}`)
        .send({ opening_float_cents: float });
    const closeShift = (id: number, counted = 0) =>
      request(app)
        .post(`/api/cash-sessions/${id}/close`)
        .set('Authorization', `Bearer ${token}`)
        .send({ counted_cash_cents: counted });
    freezeClock('2026-11-15T10:00:00.000Z');
    const shift = await openShift();
    assertEqualOrThrow(shift.status, 200, 'the evening shift opens');
    const overnightOrder = insertOrder(db, ownerId, 'ready', toSql('2026-11-15T23:30:00+07:00'));
    const overnightBill = insertBill(
      db,
      overnightOrder,
      'unpaid',
      toSql('2026-11-15T23:30:00+07:00'),
    );
    freezeClock('2026-11-15T17:30:00.000Z');
    const settled = await request(app)
      .post(`/api/bills/${overnightBill}/payment`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'overnight-cash')
      .send({ method: 'cash', amount: 100 });
    assertEqualOrThrow(settled.status, 200, 'cash settles after midnight in the evening shift');
    const paidBill = db
      .prepare('SELECT paid_at, payment_details FROM bills WHERE id = ?')
      .get(overnightBill);
    assertEqualOrThrow(paidBill.paid_at, now(), 'the settlement timestamp is UTC');
    assertEqualOrThrow(
      JSON.parse(paidBill.payment_details)[0].cash_session_id,
      shift.body.id,
      'cash is attributed to the open shift',
    );
    freezeClock('2026-11-15T20:30:00.000Z');
    assertEqualOrThrow(
      (await defaultCloseDate()).body.business_date,
      '2026-11-15',
      'at 03:30 the close dialog defaults to the trading night',
    );
    const shiftBlocked = await closeDay('2026-11-15');
    assertEqualOrThrow(
      shiftBlocked.body.display_code,
      'open_shift_blocks_day_close',
      '03:30 day close first requires shift close',
    );
    const closedShift = await closeShift(shift.body.id, 10000);
    assertEqualOrThrow(closedShift.status, 200, 'the overnight shift closes');
    const shiftSnapshot = db
      .prepare('SELECT business_date, expected_cash_cents FROM cash_closures WHERE id = ?')
      .get(closedShift.body.closure_id);
    assertEqualOrThrow(
      shiftSnapshot.business_date,
      '2026-11-15',
      'shift close retains the opening business date',
    );
    assertEqualOrThrow(
      shiftSnapshot.expected_cash_cents,
      10000,
      'the drawer contains the overnight cash receipt',
    );
    const dayClosed = await closeDay('2026-11-15', 10000);
    assertEqualOrThrow(dayClosed.status, 201, '03:30 closes the previous business date');
    assertEqualOrThrow(
      dayClosed.body.zReport.period_start,
      '2026-11-14 22:00:00',
      'the day starts at 05:00 Bangkok in UTC',
    );
    assertEqualOrThrow(
      dayClosed.body.zReport.period_end,
      '2026-11-15 22:00:00',
      'the day ends at the next 05:00 Bangkok',
    );
    assertEqualOrThrow(
      dayClosed.body.zReport.expected_cash_cents,
      10000,
      'day cash reconciles with the closed shift',
    );
    assertEqualOrThrow(
      dayClosed.body.zReport.variance_cents,
      0,
      'the drawer count reconciles without a variance',
    );
    const sessionCount = db.prepare('SELECT COUNT(*) AS n FROM cash_sessions').get().n;
    for (const float of [0, 1000]) {
      const denied = await openShift(float);
      assertEqualOrThrow(
        denied.status,
        409,
        'a closed business date rejects zero and positive float openings',
      );
      assertEqualOrThrow(
        denied.body.display_code,
        'day_already_closed',
        'the refusal names the closed date',
      );
    }
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM cash_sessions').get().n,
      sessionCount,
      'refused openings leave no session rows',
    );
    const replay = await request(app)
      .post(`/api/bills/${overnightBill}/payment`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'overnight-cash')
      .send({ method: 'cash', amount: 100 });
    assertEqualOrThrow(replay.status, 200, 'a committed payment replays after shift and day close');
    freezeClock('2026-11-15T22:00:00.000Z');
    const nextShift = await openShift();
    assertEqualOrThrow(
      nextShift.status,
      200,
      'exactly 05:00 allows a shift for the next unclosed date',
    );
    assertEqualOrThrow(
      (await closeShift(nextShift.body.id)).status,
      200,
      'the next-date fixture shift closes',
    );

    console.log('\n8. Eligibility and snapshot exclude a competing writer');
    freezeClock('2026-11-16T20:30:00.000Z');
    insertBill(
      db,
      insertOrder(db, ownerId, 'served', '2026-11-16 12:00:00'),
      'paid',
      '2026-11-16 12:00:00',
    );
    const control = new Int32Array(new SharedArrayBuffer(8));
    const writer = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.sqlite);
      const db = new Database(workerData.filename, { timeout: 0 });
      const control = new Int32Array(workerData.control);
      parentPort.postMessage('ready');
      Atomics.wait(control, 0, 0);
      let result = 1;
      try {
        db.prepare("INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status) VALUES ('owner-trade', 'Owner', '2026-11-16 10:00:00', 0, 'open')").run();
      } catch (error) {
        result = String(error.code).startsWith('SQLITE_BUSY') ? 2 : 3;
      }
      db.close();
      Atomics.store(control, 1, result);
      Atomics.notify(control, 1);
    `,
      {
        eval: true,
        workerData: {
          sqlite: require.resolve('better-sqlite3'),
          filename: db.name,
          control: control.buffer,
        },
      },
    );
    await new Promise((resolve, reject) => {
      writer.once('message', resolve);
      writer.once('error', reject);
    });
    const prepare = db.prepare;
    let probed = false;
    db.prepare = function (sql: string, ...args: any[]) {
      const statement = prepare.call(this, sql, ...args);
      if (!probed && sql.includes("status = 'open' ORDER BY opened_at")) {
        const all = statement.all;
        statement.all = function (...bindings: any[]) {
          const rows = all.apply(this, bindings);
          probed = true;
          Atomics.store(control, 0, 1);
          Atomics.notify(control, 0);
          if (Atomics.wait(control, 1, 0, 5000) === 'timed-out')
            throw new Error('competing writer timed out');
          return rows;
        };
      }
      return statement;
    };
    let protectedClose;
    try {
      protectedClose = await closeDay('2026-11-16');
    } finally {
      db.prepare = prepare;
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
      await writer.terminate();
    }
    assertOrThrow(
      probed,
      'the competing connection attempts its write during eligibility checking',
    );
    assertEqualOrThrow(
      Atomics.load(control, 1),
      2,
      'the competing connection cannot write before the closure commits',
    );
    assertEqualOrThrow(protectedClose.status, 201, 'the protected close succeeds');
    assertEqualOrThrow(
      db.prepare("SELECT COUNT(*) AS n FROM cash_sessions WHERE status = 'open'").get().n,
      0,
      'no open shift slips into the closed day',
    );

    console.log('\n9. Snapshot failure rolls back opening float and releases the writer lock');
    freezeClock('2026-11-17T20:30:00.000Z');
    insertBill(
      db,
      insertOrder(db, ownerId, 'served', '2026-11-17 12:00:00'),
      'paid',
      '2026-11-17 12:00:00',
    );
    const movementsBeforeFailure = db
      .prepare('SELECT COUNT(*) AS n FROM cash_drawer_movements')
      .get().n;
    const closuresBeforeFailure = db.prepare('SELECT COUNT(*) AS n FROM cash_closures').get().n;
    db.prepare = function (sql: string, ...args: any[]) {
      if (sql.includes('COALESCE(SUM(b.paid_amount), 0) AS gross_collected'))
        throw new Error('forced snapshot failure');
      return prepare.call(this, sql, ...args);
    };
    let failedClose;
    try {
      failedClose = await closeDay('2026-11-17');
    } finally {
      db.prepare = prepare;
    }
    assertEqualOrThrow(failedClose.status, 500, 'a snapshot error is reported');
    assertEqualOrThrow(
      db.inTransaction,
      false,
      'the failed immediate transaction releases its lock',
    );
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM cash_drawer_movements').get().n,
      movementsBeforeFailure,
      'opening float is rolled back',
    );
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) AS n FROM cash_closures').get().n,
      closuresBeforeFailure,
      'no failed snapshot is retained',
    );
    assertEqualOrThrow(
      (await closeDay('2026-11-17')).status,
      201,
      'the same date can close after the failure is removed',
    );

    console.log('\n10. Existing October timestamps and stored Z windows remain unchanged');
    setSetting(db, 'business_day_start_time', '00:00');
    const octoberOrder = insertOrder(db, ownerId, 'served', '2026-10-25 18:00:00');
    const octoberBill = insertBill(db, octoberOrder, 'paid', '2026-10-25 18:01:00');
    const octoberClose = await closeDay('2026-10-26');
    assertEqualOrThrow(
      octoberClose.status,
      201,
      'an October fixture closes with its original midnight rule',
    );
    const before = JSON.stringify(db.prepare('SELECT * FROM bills WHERE id = ?').get(octoberBill));
    const orderBefore = JSON.stringify(
      db.prepare('SELECT * FROM orders WHERE id = ?').get(octoberOrder),
    );
    setSetting(db, 'business_day_start_time', '05:00');
    const historical = await request(app)
      .get('/api/reports/z-report?date=2026-10-26')
      .set('Authorization', `Bearer ${token}`);
    assertEqualOrThrow(historical.status, 200, 'historical Z remains readable');
    assertEqualOrThrow(
      historical.body.zReport.period_start,
      '2026-10-25 17:00:00',
      'historical Z retains its original midnight start',
    );
    assertEqualOrThrow(
      historical.body.zReport.period_end,
      '2026-10-26 17:00:00',
      'historical Z retains its original midnight end',
    );
    assertEqualOrThrow(
      JSON.stringify(db.prepare('SELECT * FROM bills WHERE id = ?').get(octoberBill)),
      before,
      'reading history does not rewrite October bill data',
    );
    assertEqualOrThrow(
      JSON.stringify(db.prepare('SELECT * FROM orders WHERE id = ?').get(octoberOrder)),
      orderBefore,
      'reading history does not rewrite October order data',
    );

    console.log('\n11. Shift and day-close permissions remain enforced');
    db.prepare(`INSERT INTO users (id, name, password, role, is_active, created_at, updated_at)
      VALUES ('cashier-trade', 'Cashier', ?, 'cashier', 1, ?, ?)`).run(
      bcrypt.hashSync('pw', 4),
      now(),
      now(),
    );
    const cashierToken = jwt.sign({ userId: 'cashier-trade', role: 'cashier' }, getJWTSecret(), {
      expiresIn: '1h',
    });
    const unauthenticated = await request(app)
      .post('/api/cash-closures')
      .send({ business_date: '2026-11-18', opening_float_cents: 0, counted_cash_cents: 0 });
    assertEqualOrThrow(unauthenticated.status, 401, 'day close requires authentication');
    const forbiddenClose = await request(app)
      .post('/api/cash-closures')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ business_date: '2026-11-18', opening_float_cents: 0, counted_cash_cents: 0 });
    assertEqualOrThrow(
      forbiddenClose.status,
      403,
      'a cashier cannot close the business day by default',
    );
    freezeClock('2026-11-18T10:00:00.000Z');
    const ownerShift = await openShift();
    assertEqualOrThrow(ownerShift.status, 200, 'the owner opens an unclosed business-date shift');
    const foreignShiftClose = await request(app)
      .post(`/api/cash-sessions/${ownerShift.body.id}/close`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ counted_cash_cents: 0 });
    assertEqualOrThrow(
      foreignShiftClose.status,
      403,
      "a cashier cannot close another staff member's shift",
    );
    assertEqualOrThrow(
      (await closeShift(ownerShift.body.id)).status,
      200,
      'the authorized owner can still close the shift',
    );

    console.log('\n12. A morning close cannot lock the coming evening');
    // Trading night of 2026-11-21 (Bangkok 19:00 and 02:30), fully settled.
    insertBill(
      db,
      insertOrder(db, ownerId, 'served', '2026-11-21 12:00:00'),
      'paid',
      '2026-11-21 12:00:00',
    );
    insertBill(
      db,
      insertOrder(db, ownerId, 'served', '2026-11-21 19:30:00'),
      'paid',
      '2026-11-21 19:30:00',
    );
    // 08:41 Bangkok on 2026-11-22: the current business date has not traded yet.
    freezeClock('2026-11-22T01:41:00.000Z');
    assertEqualOrThrow(
      (await defaultCloseDate()).body.business_date,
      '2026-11-21',
      'in the morning the close dialog defaults to last night',
    );
    const emptyDay = await closeDay('2026-11-22');
    assertEqualOrThrow(emptyDay.status, 409, 'the empty current day cannot close');
    assertEqualOrThrow(
      emptyDay.body?.display_code,
      'no_trade_blocks_day_close',
      'refusal names the missing sales',
    );
    assertEqualOrThrow(
      (await closeDay('2026-11-21')).status,
      201,
      'morning close of last night succeeds',
    );
    assertEqualOrThrow(
      (await defaultCloseDate()).body.business_date,
      '2026-11-22',
      'with last night closed the default falls back to the current date',
    );
    // 17:30 Bangkok: the evening shift still opens.
    freezeClock('2026-11-22T10:30:00.000Z');
    const eveningShift = await openShift();
    assertEqualOrThrow(eveningShift.status, 200, 'the evening shift opens after a morning close');
    assertEqualOrThrow(
      (await closeShift(eveningShift.body.id)).status,
      200,
      'the evening fixture shift closes',
    );
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
