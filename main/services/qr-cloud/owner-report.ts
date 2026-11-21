import {
  dayBoundsInTimezone,
  getDatabase,
  parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../../db';
import { businessDateForInstant } from '../../../shared/business-date';
import { buildDailySalesExportDataset, resolveExportTimezone } from '../daily-sales-export';
import { getTenantCurrency } from '../refund';
import { getCurrencyMinorUnitFactor } from '../../countries';
import { readConnectorSetting, type QrCloudConfig } from './config';
import { publishOwnerReports, QrCloudClientError } from './client';
import { catalogImageOf } from './catalog';
import { readApprovedCa } from './tls';

export const OWNER_REPORT_VERSION = 1;
const SYNC_INTERVAL_MS = 5 * 60_000;
const BACKFILL_INTERVAL_MS = 30_000;
const UNSUPPORTED_RETRY_MS = 60 * 60_000;
const BACKFILL_DAYS = 62;
const BATCH_DAYS = 7;
const TOP_ITEMS = 30;
const ON_TIME_MINUTES = 20;
const MAX_KITCHEN_MINUTES = 240;
const TABLE_STEP_MINUTES = 5;

const money = (value: number | null | undefined) => Math.round(Number(value || 0) * 100) / 100;
const minutesBetween = (from: string | null, to: string | null) => {
  if (!from || !to) return null;
  const minutes = (parseDbTimestamp(to).getTime() - parseDbTimestamp(from).getTime()) / 60_000;
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= MAX_KITCHEN_MINUTES ? minutes : null;
};

/** Aggregates one business day for the owner dashboard. No customer or staff identities leave the POS. */
export function buildOwnerDailyReport(businessDate: string, nowInstant: Date = new Date()) {
  const db = getDatabase();
  const timezone = resolveExportTimezone(db);
  const dayStart = tenantBusinessDayStartTime(db);
  const [start, end] = dayBoundsInTimezone(businessDate, timezone, dayStart);
  const dataset = buildDailySalesExportDataset({ date: businessDate }, db);
  const summary = dataset.summary;
  const currency = getTenantCurrency(db);
  const minorFactor = getCurrencyMinorUnitFactor(currency);
  const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
  const localHour = (instant: Date) => {
    const hour = Number(hourFormatter.formatToParts(instant).find((part) => part.type === 'hour')?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour % 24 : 0;
  };

  const hours = Array.from({ length: 24 }, () => ({ sales: 0, bills: 0 }));
  for (const bill of db
    .prepare('SELECT paid_at, paid_amount FROM bills WHERE paid_at >= ? AND paid_at < ?')
    .all(start, end) as { paid_at: string; paid_amount: number | null }[]) {
    const slot = hours[localHour(parseDbTimestamp(bill.paid_at))];
    slot.sales += Number(bill.paid_amount || 0);
    slot.bills += 1;
  }
  for (const refund of db
    .prepare('SELECT created_at, amount_cents FROM refunds WHERE created_at >= ? AND created_at < ?')
    .all(start, end) as { created_at: string; amount_cents: number }[])
    hours[localHour(parseDbTimestamp(refund.created_at))].sales -= refund.amount_cents / minorFactor;

  const productInfo = db.prepare(
    'SELECT p.image_url, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?',
  );
  const categories = new Map<string, { name: string | null; net: number; qty: number }>();
  const items = dataset.items.map((item) => {
    const info = productInfo.get(item.product_id) as { image_url: string | null; category: string | null } | undefined;
    const key = info?.category ?? '';
    const category = categories.get(key) ?? { name: info?.category ?? null, net: 0, qty: 0 };
    category.net += item.net_item_sales;
    category.qty += item.quantity;
    categories.set(key, category);
    return {
      product_id: item.product_id,
      name: item.product_name,
      qty: item.quantity,
      net: money(item.net_item_sales),
      image: catalogImageOf(info?.image_url)?.name ?? null,
    };
  });
  items.sort((a, b) => b.net - a.net || b.qty - a.qty);

  const orders = db
    .prepare(
      `SELECT o.id, o.status, o.type, o.table_id, o.customer_id, o.guest_count, o.created_at,
              o.cooking_started_at, o.ready_at, o.completed_at,
              (SELECT MAX(b.paid_at) FROM bills b WHERE b.order_id = o.id) AS paid_at
       FROM orders o WHERE o.created_at >= ? AND o.created_at < ?`,
    )
    .all(start, end) as {
    id: number;
    status: string;
    type: string;
    table_id: string | null;
    customer_id: string | null;
    guest_count: number | null;
    created_at: string;
    cooking_started_at: string | null;
    ready_at: string | null;
    completed_at: string | null;
    paid_at: string | null;
  }[];
  const live = orders.filter((order) => order.status !== 'cancelled');

  const kitchen = { timed: 0, wait_minutes: 0, prep_minutes: 0, on_time: 0 };
  for (const order of live) {
    const wait = minutesBetween(order.created_at, order.cooking_started_at);
    const prep = minutesBetween(order.cooking_started_at, order.ready_at);
    const total = minutesBetween(order.created_at, order.ready_at);
    if (wait === null || prep === null || total === null) continue;
    kitchen.timed += 1;
    kitchen.wait_minutes += wait;
    kitchen.prep_minutes += prep;
    if (total <= ON_TIME_MINUTES) kitchen.on_time += 1;
  }

  const tableCount = (db.prepare('SELECT COUNT(*) AS n FROM tables WHERE is_active = 1').get() as { n: number }).n;
  const occupied = Array.from({ length: 24 }, () => 0);
  const byTable = new Map<string, [number, number][]>();
  const dayEnd = Math.min(parseDbTimestamp(end).getTime(), nowInstant.getTime());
  for (const order of live) {
    if (!order.table_id) continue;
    const from = parseDbTimestamp(order.created_at).getTime();
    const closedAt = order.completed_at ?? order.paid_at;
    const to = closedAt ? parseDbTimestamp(closedAt).getTime() : dayEnd;
    if (!(to > from)) continue;
    const spans = byTable.get(order.table_id) ?? [];
    spans.push([from, Math.min(to, from + 6 * 3_600_000)]);
    byTable.set(order.table_id, spans);
  }
  for (const spans of byTable.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [from, to] of spans) {
      for (let at = Math.max(from, cursor); at < to; at += TABLE_STEP_MINUTES * 60_000)
        occupied[localHour(new Date(at))] += TABLE_STEP_MINUTES;
      cursor = Math.max(cursor, to);
    }
  }

  const customerIds = [...new Set(live.map((order) => order.customer_id).filter((id): id is string => !!id))];
  const repeatSince = new Date(parseDbTimestamp(end).getTime() - 30 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const orderCountSince = db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status <> 'cancelled' AND created_at >= ? AND created_at < ?",
  );
  const repeat = customerIds.filter(
    (id) => (orderCountSince.get(id, repeatSince, end) as { n: number }).n >= 3,
  ).length;
  const promoOrders = (db
    .prepare(
      `SELECT COUNT(DISTINCT p.order_id) AS n FROM order_promotions p JOIN orders o ON o.id = p.order_id
       WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'cancelled'`,
    )
    .get(start, end) as { n: number }).n;
  const members = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS joined
       FROM customers WHERE is_active = 1 AND created_at < ?`,
    )
    .get(start, end, end) as { total: number; joined: number | null };

  const attendance = db
    .prepare(
      `SELECT a.clock_in_at, a.clock_out_at, u.hourly_rate FROM staff_attendance a
       LEFT JOIN users u ON u.id = a.user_id WHERE a.business_date = ?`,
    )
    .all(businessDate) as { clock_in_at: string; clock_out_at: string | null; hourly_rate: number | null }[];
  let laborHours = 0;
  let laborCost = 0;
  let laborComplete = true;
  for (const shift of attendance) {
    const from = parseDbTimestamp(shift.clock_in_at).getTime();
    const to = shift.clock_out_at ? parseDbTimestamp(shift.clock_out_at).getTime() : Math.min(nowInstant.getTime(), from + 16 * 3_600_000);
    const worked = Math.max(0, to - from) / 3_600_000;
    laborHours += worked;
    if (shift.hourly_rate == null) laborComplete = false;
    else laborCost += worked * shift.hourly_rate;
  }

  const expenses = db
    .prepare(
      `SELECT category_name AS name, SUM(amount_minor) AS minor FROM expenses e
       WHERE incurred_on = ? AND voided_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM expenses r WHERE r.replaces_expense_id = e.id)
       GROUP BY category_name ORDER BY minor DESC`,
    )
    .all(businessDate) as { name: string; minor: number }[];

  return {
    v: OWNER_REPORT_VERSION,
    business_date: businessDate,
    currency,
    timezone,
    sales: {
      net: money(summary.net_collected),
      gross: money(summary.gross_collected),
      refunds: money(summary.refunds_issued),
      discounts: money(summary.discount_total),
      tax: money(summary.tax_total),
      orders: summary.order_count,
      bills: summary.paid_bill_count,
      cancelled_orders: orders.length - live.length,
      guests: live.reduce((sum, order) => sum + (order.guest_count && order.guest_count > 0 ? order.guest_count : 1), 0),
      guests_estimated: live.some((order) => !order.guest_count),
    },
    cost: {
      ingredient: summary.ingredient_cost_total === null ? null : money(summary.ingredient_cost_total),
      ingredient_coverage: summary.cost_coverage_status,
      known_cost_sales: money(summary.known_cost_net_item_sales),
      labor: money(laborCost),
      labor_hours: Math.round(laborHours * 100) / 100,
      labor_complete: laborComplete,
      expenses: expenses.map((row) => ({ name: row.name, amount: money(row.minor / minorFactor) })),
    },
    payments: summary.payment_methods.map((row) => ({ method: row.method, count: row.count, total: money(row.total) })),
    categories: [...categories.values()]
      .map((row) => ({ name: row.name, net: money(row.net), qty: row.qty }))
      .sort((a, b) => b.net - a.net),
    items: items.slice(0, TOP_ITEMS),
    hours: hours.map((slot) => ({ sales: money(slot.sales), bills: slot.bills })),
    tables: { count: tableCount, occupied_minutes: occupied },
    kitchen: {
      timed: kitchen.timed,
      wait_minutes: Math.round(kitchen.wait_minutes * 10) / 10,
      prep_minutes: Math.round(kitchen.prep_minutes * 10) / 10,
      on_time: kitchen.on_time,
      on_time_minutes: ON_TIME_MINUTES,
    },
    customers: {
      members: members.total,
      new_members: members.joined ?? 0,
      member_visits: customerIds.length,
      repeat_members: repeat,
      promo_orders: promoOrders,
    },
    staff: { on_duty: attendance.length },
  };
}

export type OwnerDailyReport = ReturnType<typeof buildOwnerDailyReport>;

let nextSyncAt = 0;
let backfill: string[] | null = null;

export function __resetOwnerReportScheduleForTests(): void {
  nextSyncAt = 0;
  backfill = null;
}

function previousDates(today: string, count: number) {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(base - (index + 1) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Publishes today and yesterday every few minutes, and the last two months once after start-up. */
export async function syncOwnerReports(config: QrCloudConfig, signal: AbortSignal, nowInstant: Date = new Date()) {
  if (nowInstant.getTime() < nextSyncAt) return;
  const db = getDatabase();
  const today = businessDateForInstant({
    instant: nowInstant,
    timezone: resolveExportTimezone(db),
    startTime: tenantBusinessDayStartTime(db),
  });
  backfill ??= previousDates(today, BACKFILL_DAYS).slice(1);
  const batch = backfill.slice(0, BATCH_DAYS);
  const dates = [today, previousDates(today, 1)[0], ...batch];
  nextSyncAt = nowInstant.getTime() + (backfill.length > batch.length ? BACKFILL_INTERVAL_MS : SYNC_INTERVAL_MS);
  const reports = dates.map((date) => buildOwnerDailyReport(date, nowInstant));
  try {
    await publishOwnerReports(
      { config, token: readConnectorSetting(), caPem: readApprovedCa()?.pem, signal },
      reports,
    );
    backfill = backfill.slice(batch.length);
  } catch (error) {
    if (error instanceof QrCloudClientError && error.detail === 'HTTP 404')
      nextSyncAt = nowInstant.getTime() + UNSUPPORTED_RETRY_MS;
  }
}
