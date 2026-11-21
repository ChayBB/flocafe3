/**
 * Owner dashboard reports: the POS aggregates each business day (sales, items, hours, tables,
 * kitchen, members, staff, expenses) without identities and publishes it to the Cloud.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-cloud-owner-report.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-owner-report-test-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => tempRoot, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
        decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8'),
      },
    };
  return originalLoad.apply(this, arguments as never);
};
process.env.FLO_QR_CLOUD_DIR = path.join(tempRoot, 'qr-cloud');

const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  initTestDb, closeDatabase, now, seedOwnerUser, seedCategory, seedProduct,
  assertOrThrow, assertEqualOrThrow, getResults, resetCounters,
} = require('./helpers/test-setup');
const config = require('../main/services/qr-cloud/config');
const ownerReport = require('../main/services/qr-cloud/owner-report');

const ts = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace(/\..*$/, '');
const PHOTO = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tea')]).toString('base64')}`;

async function main() {
  resetCounters();
  const db = initTestDb();
  seedOwnerUser(db);
  const setSetting = (key: string, value: string) =>
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, now());
  setSetting('country', 'TH');
  setSetting('currency', 'THB');
  setSetting('timezone', 'Asia/Bangkok');
  setSetting('business_day_start_time', '00:00');
  seedCategory(db, 'cat-drink', 'Drinks');
  seedCategory(db, 'cat-food', 'Food');
  seedProduct(db, 'p-tea', 'cat-drink', 'Thai tea', 50);
  seedProduct(db, 'p-rice', 'cat-food', 'Fried rice', 100);
  db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(PHOTO, 'p-tea');
  db.prepare("INSERT INTO tables (id, number, is_active) VALUES ('t1', '1', 1), ('t2', '2', 1)").run();
  db.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES ('c1', 'Somchai', '0800000001', ?), ('c2', 'Old', '0800000002', ?)")
    .run(ts('2026-11-20T03:00:00Z'), ts('2026-01-01T03:00:00Z'));
  db.prepare("UPDATE users SET hourly_rate = 50 WHERE id = 'owner-test-001'").run();
  db.prepare(
    `INSERT INTO staff_attendance (user_id, business_date, clock_in_at, clock_out_at, created_at, updated_at)
     VALUES ('owner-test-001', '2026-11-20', ?, ?, ?, ?)`,
  ).run(ts('2026-11-20T02:00:00Z'), ts('2026-11-20T10:00:00Z'), now(), now());
  db.prepare("INSERT INTO expense_categories (id, name, name_key, created_by, updated_by, created_at, updated_at) VALUES ('ec1', 'Gas', 'gas', 'owner-test-001', 'owner-test-001', ?, ?)").run(now(), now());
  db.prepare(
    `INSERT INTO expenses (id, category_id, category_name, description, amount_minor, currency_code, incurred_on, created_by, created_at)
     VALUES ('e1', 'ec1', 'Gas', 'LPG', 30000, 'THB', '2026-11-20', 'owner-test-001', ?)`,
  ).run(now());

  let seq = 0;
  function order(opts: { at: string; table?: string; customer?: string; guests?: number; items: [string, string, number, number][]; method?: string; status?: string; started?: number; ready?: number; minutes?: number }) {
    seq += 1;
    const created = ts(opts.at);
    const later = (minutes: number) => ts(new Date(Date.parse(opts.at) + minutes * 60_000).toISOString());
    const total = opts.items.reduce((sum, [, , qty, price]) => sum + qty * price, 0);
    const status = opts.status ?? 'completed';
    const orderId = Number(db.prepare(
      `INSERT INTO orders (order_number, user_id, type, status, table_id, customer_id, guest_count, subtotal, total,
         created_at, updated_at, cooking_started_at, ready_at, completed_at, cancelled_at)
       VALUES (?, 'owner-test-001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`ORD-${seq}`, opts.table ? 'dine_in' : 'takeaway', status, opts.table ?? null, opts.customer ?? null, opts.guests ?? null,
      total, total, created, created, opts.started === undefined ? null : later(opts.started), opts.ready === undefined ? null : later(opts.ready),
      status === 'completed' ? later(opts.minutes ?? 30) : null, status === 'cancelled' ? later(5) : null).lastInsertRowid);
    for (const [productId, name, qty, price] of opts.items)
      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      ).run(orderId, productId, name, qty, price, qty * price, qty * price, created, created);
    if (status !== 'completed') return orderId;
    const paid = later(opts.minutes ?? 30);
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)`,
    ).run(`BILL-${seq}`, orderId, total, total, total, JSON.stringify([{ method: opts.method ?? 'cash', amount: total, timestamp: paid }]), paid, paid, paid);
    return orderId;
  }

  // 2026-11-20 Bangkok: 12:00 (05:00Z) lunch at table 1, 12:10 at table 2, 18:00 takeaway.
  order({ at: '2026-11-20T05:00:00Z', table: 't1', customer: 'c1', guests: 3, items: [['p-rice', 'Fried rice', 2, 100], ['p-tea', 'Thai tea', 2, 50]], started: 2, ready: 14, minutes: 60 });
  order({ at: '2026-11-20T05:10:00Z', table: 't2', guests: 2, items: [['p-tea', 'Thai tea', 4, 50]], method: 'promptpay', started: 5, ready: 35, minutes: 30 });
  order({ at: '2026-11-20T11:00:00Z', customer: 'c2', items: [['p-rice', 'Fried rice', 1, 100]] });
  order({ at: '2026-11-20T11:30:00Z', status: 'cancelled', items: [['p-tea', 'Thai tea', 1, 50]] });
  for (const day of ['2026-11-01', '2026-11-08', '2026-11-15'])
    order({ at: `${day}T05:00:00Z`, customer: 'c2', items: [['p-tea', 'Thai tea', 1, 50]] });

  const originalRequest = https.request;
  const sent: { path: string; body: string }[] = [];
  let status = 200;
  https.request = (options: any, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as any;
    request.end = (body: string) => {
      sent.push({ path: options.path, body });
      const response = new PassThrough() as any;
      response.statusCode = status;
      callback(response);
      response.end(JSON.stringify({ accepted: 1 }));
    };
    request.destroy = () => {};
    return request;
  };

  try {
    const report = ownerReport.buildOwnerDailyReport('2026-11-20', new Date('2026-11-21T05:00:00Z'));
    assertEqualOrThrow(report.business_date, '2026-11-20', 'the report names its business day');
    assertEqualOrThrow(report.currency, 'THB', 'the store currency is included');
    assertEqualOrThrow(report.sales.net, 600, 'net sales come from the daily sales export');
    assertEqualOrThrow(report.sales.bills, 3, 'paid bills are counted');
    assertEqualOrThrow(report.sales.cancelled_orders, 1, 'cancelled orders are counted separately');
    assertEqualOrThrow(report.sales.guests, 6, 'guests use the guest count, one per order without it');
    assertOrThrow(report.sales.guests_estimated, 'a missing guest count marks guests as estimated');
    assertEqualOrThrow(report.hours[13].sales, 300, 'a bill paid at 13:00 Bangkok lands in the 13:00 hour');
    assertEqualOrThrow(report.hours[12].sales, 200, 'a bill paid at 12:40 Bangkok lands in the 12:00 hour');
    assertEqualOrThrow(report.hours[18].bills, 1, 'the evening bill lands at 18:00');
    assertEqualOrThrow(report.payments.find((p: any) => p.method === 'promptpay')?.total, 200, 'payment methods are totalled');
    assertEqualOrThrow(report.items[0].name, 'Thai tea', 'items are ranked by net sales');
    assertOrThrow(/^[a-f0-9]{64}\.png$/.test(report.items[0].image), 'an item photo is referenced by its catalog image name');
    assertEqualOrThrow(report.categories.map((c: any) => `${c.name}:${c.net}:${c.qty}`).sort().join(','), 'Drinks:300:6,Food:300:3', 'items are totalled by category');
    assertEqualOrThrow(report.tables.count, 2, 'active tables are counted');
    assertEqualOrThrow(report.tables.occupied_minutes[12], 90, 'table minutes are merged per table and bucketed by local hour');
    assertEqualOrThrow(report.kitchen.timed, 2, 'orders with kitchen timestamps are timed');
    assertEqualOrThrow(report.kitchen.wait_minutes, 7, 'waiting time before cooking is summed');
    assertEqualOrThrow(report.kitchen.prep_minutes, 42, 'preparation time is summed');
    assertEqualOrThrow(report.kitchen.on_time, 1, 'orders ready within the on-time limit are counted');
    assertEqualOrThrow(report.customers.new_members, 1, 'members who joined that day are counted');
    assertEqualOrThrow(report.customers.member_visits, 2, 'distinct visiting members are counted');
    assertEqualOrThrow(report.customers.repeat_members, 1, 'members with three visits in 30 days are regulars');
    assertEqualOrThrow(report.staff.on_duty, 1, 'clocked-in staff are counted');
    assertEqualOrThrow(report.cost.labor, 400, 'labor cost uses hours worked and hourly rate');
    assertEqualOrThrow(report.cost.expenses[0].amount, 300, 'expenses are converted from minor units');
    const serialized = JSON.stringify(report);
    assertOrThrow(!serialized.includes('Somchai') && !serialized.includes('0800000001') && !serialized.includes('owner-test-001'),
      'no customer or staff identity leaves the POS');

    config.updateConfig({ cloudUrl: 'https://qr-ordering.accesscam.org' });
    config.writeConnectorToken('owner-report-connector-token-0123456789');
    ownerReport.__resetOwnerReportScheduleForTests();
    const signal = new AbortController().signal;
    await ownerReport.syncOwnerReports(config.readConfig(), signal, new Date('2026-11-21T05:00:00Z'));
    assertEqualOrThrow(sent[0].path, '/api/v1/connectors/reports', 'reports are published to the connector route');
    const dates = JSON.parse(sent[0].body).reports.map((r: any) => r.business_date);
    assertEqualOrThrow(dates.slice(0, 3).join(','), '2026-11-21,2026-11-20,2026-11-19', 'today, yesterday, then the backfill are sent');
    assertEqualOrThrow(dates.length, 9, 'the backfill is sent a week at a time');
    await ownerReport.syncOwnerReports(config.readConfig(), signal, new Date('2026-11-21T05:00:10Z'));
    assertEqualOrThrow(sent.length, 1, 'publishing waits between batches');
    await ownerReport.syncOwnerReports(config.readConfig(), signal, new Date('2026-11-21T05:00:31Z'));
    assertEqualOrThrow(JSON.parse(sent[1].body).reports[2].business_date, '2026-11-12', 'the next batch continues the backfill');

    status = 404;
    ownerReport.__resetOwnerReportScheduleForTests();
    sent.length = 0;
    await ownerReport.syncOwnerReports(config.readConfig(), signal, new Date('2026-11-21T06:00:00Z'));
    await ownerReport.syncOwnerReports(config.readConfig(), signal, new Date('2026-11-21T06:30:00Z'));
    assertEqualOrThrow(sent.length, 1, 'a Cloud without the reports route is retried only hourly');
  } finally {
    https.request = originalRequest;
    require('../main/services/qr-cloud/inbox').closeInbox();
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\nQR cloud owner report: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
