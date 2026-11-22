/**
 * GET /api/reports/executive-summary: owner/manager KPIs for a business-date range compared with
 * an earlier range, with financial figures limited to reports.financial.view.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/executive-summary.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-executive-summary-test-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => tempRoot, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as never);
};

const jwt = require('jsonwebtoken');
const {
  initTestDb,
  closeDatabase,
  now,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  resetCounters,
  getResults,
} = require('./helpers/test-setup');
const { reportRoutes } = require('../main/routes/reports');
const { resolveExecutiveRanges } = require('../main/services/executive-summary');

const ts = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace(/\..*$/, '');

async function main() {
  resetCounters();
  console.log('GET /api/reports/executive-summary');

  const ranges = (start: string, end: string, compare?: string) =>
    resolveExecutiveRanges(start, end, compare).compare;
  assertEqualOrThrow(
    JSON.stringify(ranges('2026-11-16', '2026-11-20', 'previous_period')),
    JSON.stringify({ startDate: '2026-11-11', endDate: '2026-11-15', days: 5 }),
    'the previous period is the same length, ending the day before',
  );
  assertEqualOrThrow(
    ranges('2026-11-16', '2026-11-20')?.startDate,
    '2026-11-11',
    'the previous period is the default comparison',
  );
  assertEqualOrThrow(
    `${ranges('2026-11-01', '2026-11-30', 'previous_month')?.startDate}..${ranges('2026-11-01', '2026-11-30', 'previous_month')?.endDate}`,
    '2026-10-01..2026-10-31',
    'a whole month compares with the whole previous month',
  );
  assertEqualOrThrow(
    ranges('2026-03-01', '2026-03-31', 'previous_month')?.endDate,
    '2026-02-28',
    'a whole month ending on the 31st compares with the end of February',
  );
  assertEqualOrThrow(
    ranges('2026-03-05', '2026-03-31', 'previous_month')?.endDate,
    '2026-02-28',
    'a day past the end of the previous month is clamped',
  );
  assertEqualOrThrow(
    ranges('2028-02-29', '2028-02-29', 'previous_year')?.startDate,
    '2027-02-28',
    'a leap day compares with the last day of February a year earlier',
  );
  assertEqualOrThrow(
    ranges('2026-11-01', '2026-11-20', 'none'),
    null,
    'no comparison when asked for none',
  );

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  setSetting('country', 'TH');
  setSetting('currency', 'THB');
  setSetting('timezone', 'Asia/Bangkok');
  setSetting('business_day_start_time', '00:00');
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('cashier-exec', 'Cashier', 'cashier-exec@test.local', 'x', 'cashier', 1, ?, ?)`,
  ).run(now(), now());
  const { getJWTSecret } = require('../main/routes/auth');
  const cashierToken = jwt.sign({ userId: 'cashier-exec', role: 'cashier' }, getJWTSecret(), {
    expiresIn: '1h',
  });

  seedCategory(db, 'cat-drink', 'Drinks');
  seedCategory(db, 'cat-food', 'Food');
  seedProduct(db, 'p-tea', 'cat-drink', 'Thai tea', 50);
  seedProduct(db, 'p-rice', 'cat-food', 'Fried rice', 120);
  db.prepare(
    "INSERT INTO tables (id, number, is_active) VALUES ('t1', '1', 1), ('t2', '2', 1)",
  ).run();
  db.prepare('DELETE FROM customers').run();
  db.prepare(
    "INSERT INTO customers (id, name, phone, created_at) VALUES ('c1', 'New', '0800000001', ?), ('c2', 'Regular', '0800000002', ?)",
  ).run(ts('2026-11-20T03:00:00Z'), ts('2026-01-01T03:00:00Z'));
  db.prepare('UPDATE users SET hourly_rate = 50 WHERE id = ?').run(owner.userId);
  const attend = db.prepare(
    `INSERT INTO staff_attendance (user_id, business_date, clock_in_at, clock_out_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  attend.run(
    owner.userId,
    '2026-11-20',
    ts('2026-11-20T02:00:00Z'),
    ts('2026-11-20T10:00:00Z'),
    now(),
    now(),
  );
  attend.run(
    'cashier-exec',
    '2026-11-19',
    ts('2026-11-19T02:00:00Z'),
    ts('2026-11-19T06:00:00Z'),
    now(),
    now(),
  );
  db.prepare(
    "INSERT INTO expense_categories (id, name, name_key, created_by, updated_by, created_at, updated_at) VALUES ('ec1', 'Gas', 'gas', ?, ?, ?, ?)",
  ).run(owner.userId, owner.userId, now(), now());
  const expense = db.prepare(
    `INSERT INTO expenses (id, category_id, category_name, description, amount_minor, currency_code, incurred_on, created_by, created_at, voided_at)
     VALUES (?, 'ec1', 'Gas', 'LPG', ?, 'THB', ?, ?, ?, ?)`,
  );
  expense.run('e1', 30000, '2026-11-20', owner.userId, now(), null);
  expense.run('e2', 99900, '2026-11-19', owner.userId, now(), now());

  let seq = 0;
  type Line = [string, string, number, number, number | null];
  function order(opts: {
    at: string;
    table?: string;
    customer?: string;
    guests?: number;
    items: Line[];
    status?: string;
    started?: number;
    ready?: number;
    minutes?: number;
  }) {
    seq += 1;
    const created = ts(opts.at);
    const later = (minutes: number) =>
      ts(new Date(Date.parse(opts.at) + minutes * 60_000).toISOString());
    const total = opts.items.reduce((sum, [, , qty, price]) => sum + qty * price, 0);
    const status = opts.status ?? 'completed';
    const orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (order_number, user_id, type, status, table_id, customer_id, guest_count, subtotal, total,
         created_at, updated_at, cooking_started_at, ready_at, completed_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `EXEC-${seq}`,
          owner.userId,
          opts.table ? 'dine_in' : 'takeaway',
          status,
          opts.table ?? null,
          opts.customer ?? null,
          opts.guests ?? null,
          total,
          total,
          created,
          created,
          opts.started === undefined ? null : later(opts.started),
          opts.ready === undefined ? null : later(opts.ready),
          status === 'completed' ? later(opts.minutes ?? 30) : null,
          status === 'cancelled' ? later(5) : null,
        ).lastInsertRowid,
    );
    for (const [productId, name, qty, price, cost] of opts.items)
      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status,
           ingredient_cost_known, ingredient_cost, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      ).run(
        orderId,
        productId,
        name,
        qty,
        price,
        qty * price,
        qty * price,
        cost === null ? 0 : 1,
        cost,
        created,
        created,
      );
    if (status !== 'completed') return;
    const paid = later(opts.minutes ?? 30);
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)`,
    ).run(
      `EXEC-BILL-${seq}`,
      orderId,
      total,
      total,
      total,
      JSON.stringify([{ method: 'cash', amount: total, timestamp: paid }]),
      paid,
      paid,
      paid,
    );
  }

  // Current range 2026-11-16..20 (Bangkok): two lunch tables on the 20th, an evening takeaway and a cancellation on the 18th.
  order({
    at: '2026-11-20T05:00:00Z',
    table: 't1',
    customer: 'c1',
    guests: 3,
    items: [
      ['p-rice', 'Fried rice', 2, 120, 80],
      ['p-tea', 'Thai tea', 2, 50, null],
    ],
    started: 2,
    ready: 14,
    minutes: 60,
  });
  order({
    at: '2026-11-20T05:10:00Z',
    table: 't2',
    guests: 2,
    items: [['p-tea', 'Thai tea', 4, 50, null]],
    started: 5,
    ready: 35,
    minutes: 30,
  });
  order({
    at: '2026-11-18T11:00:00Z',
    customer: 'c2',
    items: [['p-rice', 'Fried rice', 1, 120, 40]],
  });
  order({
    at: '2026-11-18T11:30:00Z',
    status: 'cancelled',
    items: [['p-tea', 'Thai tea', 1, 50, null]],
  });
  // Previous period 2026-11-11..15.
  order({
    at: '2026-11-12T05:00:00Z',
    customer: 'c2',
    items: [
      ['p-rice', 'Fried rice', 2, 120, 80],
      ['p-tea', 'Thai tea', 4, 50, null],
    ],
  });

  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);
  const get = (query: string, token: string) =>
    api(baseUrl, `/api/reports/executive-summary${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  try {
    const range = '?start_date=2026-11-16&end_date=2026-11-20&compare=previous_period';
    const res = await get(range, owner.token);
    assertEqualOrThrow(res.status, 200, 'the owner can open the executive summary');
    const s = res.data.executiveSummary;
    assertEqualOrThrow(s.compare.startDate, '2026-11-11', 'the comparison range is reported');
    assertEqualOrThrow(s.kpis.sales.value, 660, 'sales are collected bills in the range');
    assertEqualOrThrow(s.kpis.sales.previous, 440, 'previous sales come from the comparison range');
    assertEqualOrThrow(s.kpis.sales.changePercent, 50, 'the sales change is a percentage');
    assertEqualOrThrow(s.kpis.bills.value, 3, 'paid bills are counted');
    assertEqualOrThrow(
      s.kpis.averageOrderValue.value,
      220,
      'average order value is sales per bill',
    );
    assertEqualOrThrow(
      s.kpis.guests.value,
      6,
      'guests use the guest count, one per order without it',
    );
    assertOrThrow(s.kpis.guests.estimated, 'a missing guest count marks guests as estimated');
    assertEqualOrThrow(
      s.kpis.tableUtilisation.value,
      37.5,
      'table use is occupied minutes over trading-hour capacity',
    );
    assertEqualOrThrow(
      s.kpis.tableUtilisation.changePoints,
      37.5,
      'rate changes are in percentage points',
    );
    assertEqualOrThrow(
      s.kpis.grossMargin.value,
      66.67,
      'gross margin uses the items with a known cost',
    );
    assertEqualOrThrow(
      s.kpis.grossMargin.costStatus,
      'partial',
      'partial cost coverage is flagged',
    );

    assertEqualOrThrow(
      s.trend.daily.current.length,
      5,
      'the daily trend has a point per business date',
    );
    assertEqualOrThrow(s.trend.daily.current[4].sales, 540, 'the 20th collects both lunch bills');
    assertEqualOrThrow(s.trend.daily.current[2].sales, 120, 'the 18th collects the evening bill');
    assertEqualOrThrow(
      s.trend.daily.previous[1].sales,
      440,
      'the previous trend lines up day by day',
    );
    assertEqualOrThrow(s.trend.monthly.current[0].sales, 660, 'monthly buckets total the days');

    assertEqualOrThrow(s.categories[0].name, 'Food', 'categories are ranked by sales');
    assertEqualOrThrow(
      s.categories[0].salesPercent,
      54.5,
      'category share is a percent of item sales',
    );
    assertEqualOrThrow(s.topItems.byRevenue[0].name, 'Fried rice', 'top items by revenue');
    assertEqualOrThrow(s.topItems.byQuantity[0].name, 'Thai tea', 'top items by quantity');
    assertEqualOrThrow(
      s.topItems.byQuantity[0].quantity,
      6,
      'cancelled orders are not counted in item quantity',
    );

    assertEqualOrThrow(s.operations.orders, 4, 'all orders are counted');
    assertEqualOrThrow(s.operations.cancelPercent, 25, 'cancel rate is cancelled over all orders');
    assertEqualOrThrow(s.operations.timedOrders, 2, 'orders with kitchen timestamps are timed');
    assertEqualOrThrow(s.operations.avgWaitMinutes, 3.5, 'average wait before cooking');
    assertEqualOrThrow(s.operations.avgPrepMinutes, 21, 'average preparation time');
    assertEqualOrThrow(
      s.operations.onTimePercent,
      50,
      'on-time rate uses the kitchen on-time limit',
    );

    assertEqualOrThrow(s.tables.count, 2, 'active tables are counted');
    assertEqualOrThrow(
      JSON.stringify(s.tables.peakHours),
      '[12]',
      'peak table hours are store-local hours',
    );
    assertEqualOrThrow(
      s.tables.byHour.find((h: any) => h.hour === 12)?.percent,
      75,
      'hourly table use',
    );
    assertEqualOrThrow(s.tables.seatingsPerTablePerDay, 0.5, 'seatings per table per trading day');

    assertEqualOrThrow(s.customers.newMembers, 1, 'members who joined in the range');
    assertEqualOrThrow(s.customers.totalMembers, 2, 'members on file at the end of the range');
    assertEqualOrThrow(s.customers.memberVisits, 2, 'distinct visiting members');
    assertEqualOrThrow(
      s.customers.returningMembers,
      1,
      'members who ordered before the range are returning',
    );

    assertEqualOrThrow(s.financial.foodCost, 120, 'food cost is the known ingredient cost');
    assertEqualOrThrow(
      s.financial.foodCostPercent,
      33.3,
      'food cost percent uses known-cost sales',
    );
    assertEqualOrThrow(
      s.financial.labour.cost,
      400,
      'labour cost uses hours worked and hourly rate',
    );
    assertEqualOrThrow(s.financial.labour.hours, 12, 'labour hours include staff without a rate');
    assertEqualOrThrow(
      s.financial.labour.complete,
      false,
      'a worked shift without a rate leaves labour incomplete',
    );
    assertEqualOrThrow(s.financial.expenses.total, 300, 'voided expenses are left out');
    assertEqualOrThrow(
      s.financial.estimatedProfit,
      -160,
      'profit is sales less tax, food, labour and expenses',
    );

    assertEqualOrThrow(
      s.hourly.date,
      '2026-11-20',
      'hourly sales are for the last day of the range',
    );
    assertEqualOrThrow(
      s.hourly.hours[13].sales,
      340,
      'a bill paid at 13:00 Bangkok lands in the 13:00 hour',
    );
    assertEqualOrThrow(
      s.hourly.hours[12].sales,
      200,
      'a bill paid at 12:40 Bangkok lands in the 12:00 hour',
    );

    const ownerRow = s.staff.find((row: any) => row.userId === owner.userId);
    assertEqualOrThrow(ownerRow.sales, 660, 'staff sales are their live orders');
    assertEqualOrThrow(ownerRow.salesPerHour, 82.5, 'sales per worked hour');
    assertEqualOrThrow(ownerRow.wage, 400, 'wages are shown with financial access');
    assertOrThrow(
      s.staff.some((row: any) => row.userId === 'cashier-exec' && row.hours === 4),
      'staff with hours but no orders are listed',
    );

    const codes = s.insights.map((insight: any) => insight.code);
    assertEqualOrThrow(
      s.insights.find((i: any) => i.code === 'salesUp')?.params.percent,
      50,
      'a sales rise is summarised',
    );
    assertEqualOrThrow(
      s.insights.find((i: any) => i.code === 'peakHour')?.params.hour,
      12,
      'the busiest order hour is summarised',
    );
    assertOrThrow(
      codes.includes('recipesMissing') && codes.includes('hourlyRatesMissing'),
      'missing costs and rates are recommended',
    );
    assertOrThrow(
      !codes.includes('onTimeLow') && !codes.includes('cancelHigh'),
      'small samples raise no kitchen or cancel warnings',
    );

    const managerRes = await get(range, manager.token);
    assertEqualOrThrow(managerRes.status, 200, 'a manager can open the executive summary');
    const m = managerRes.data.executiveSummary;
    assertEqualOrThrow(m.financial, null, 'financial figures need reports.financial.view');
    assertEqualOrThrow(m.kpis.grossMargin, null, 'gross margin needs reports.financial.view');
    assertOrThrow(
      m.staff.every((row: any) => !('wage' in row)),
      'wages need reports.financial.view',
    );
    assertOrThrow(
      !m.insights.some((i: any) => i.code === 'recipesMissing'),
      'cost recommendations need reports.financial.view',
    );
    assertEqualOrThrow(m.kpis.sales.value, 660, 'sales stay visible to a manager');

    const cashier = await get(range, cashierToken);
    assertEqualOrThrow(cashier.status, 403, 'a cashier cannot open the executive summary');

    const none = await get('?start_date=2026-11-16&end_date=2026-11-20&compare=none', owner.token);
    assertEqualOrThrow(none.data.executiveSummary.compare, null, 'compare=none has no comparison');
    assertEqualOrThrow(
      none.data.executiveSummary.kpis.sales.changePercent,
      null,
      'no change without a comparison',
    );

    for (const [query, label] of [
      ['?start_date=2026-11-20&end_date=2026-11-16', 'a reversed range'],
      ['?start_date=2026-01-01&end_date=2026-11-20', 'a range over 93 days'],
      ['?start_date=2026-02-30&end_date=2026-03-01', 'an impossible date'],
      ['?start_date=2026-11-16&end_date=2026-11-20&compare=forever', 'an unknown comparison'],
    ])
      assertEqualOrThrow((await get(query, owner.token)).status, 400, `${label} is rejected`);
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  const results = getResults();
  console.log(`\nExecutive summary: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
