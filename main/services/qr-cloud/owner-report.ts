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
import {
  billSalesByLocalHour,
  expenseTotalsByCategory,
  KITCHEN_ON_TIME_MINUTES,
  localHourReader,
  summarizeKitchen,
  tableOccupiedMinutes,
} from '../owner-metrics';

export const OWNER_REPORT_VERSION = 1;
const SYNC_INTERVAL_MS = 5 * 60_000;
const BACKFILL_INTERVAL_MS = 30_000;
const UNSUPPORTED_RETRY_MS = 60 * 60_000;
const BACKFILL_DAYS = 62;
const BATCH_DAYS = 7;
const TOP_ITEMS = 30;

const money = (value: number | null | undefined) => Math.round(Number(value || 0) * 100) / 100;

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
  const localHour = localHourReader(timezone);
  const hours = billSalesByLocalHour(db, start, end, localHour, minorFactor);

  const productInfo = db.prepare(
    'SELECT p.image_url, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?',
  );
  const categories = new Map<string, { name: string | null; net: number; qty: number }>();
  const items = dataset.items.map((item) => {
    const info = productInfo.get(item.product_id) as
      | { image_url: string | null; category: string | null }
      | undefined;
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

  const kitchen = summarizeKitchen(live);

  const tableCount = (
    db.prepare('SELECT COUNT(*) AS n FROM tables WHERE is_active = 1').get() as { n: number }
  ).n;
  const dayEnd = Math.min(parseDbTimestamp(end).getTime(), nowInstant.getTime());
  const occupiedByHour = tableOccupiedMinutes(live, localHour, dayEnd);
  const occupied = Array.from({ length: 24 }, (_, hour) => occupiedByHour.get(hour) ?? 0);

  const customerIds = [
    ...new Set(live.map((order) => order.customer_id).filter((id): id is string => !!id)),
  ];
  const repeatSince = new Date(parseDbTimestamp(end).getTime() - 30 * 86_400_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const orderCountSince = db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status <> 'cancelled' AND created_at >= ? AND created_at < ?",
  );
  const repeat = customerIds.filter(
    (id) => (orderCountSince.get(id, repeatSince, end) as { n: number }).n >= 3,
  ).length;
  const promoOrders = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT p.order_id) AS n FROM order_promotions p JOIN orders o ON o.id = p.order_id
       WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'cancelled'`,
      )
      .get(start, end) as { n: number }
  ).n;
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
    .all(businessDate) as {
    clock_in_at: string;
    clock_out_at: string | null;
    hourly_rate: number | null;
  }[];
  let laborHours = 0;
  let laborCost = 0;
  let laborComplete = true;
  for (const shift of attendance) {
    const from = parseDbTimestamp(shift.clock_in_at).getTime();
    const to = shift.clock_out_at
      ? parseDbTimestamp(shift.clock_out_at).getTime()
      : Math.min(nowInstant.getTime(), from + 16 * 3_600_000);
    const worked = Math.max(0, to - from) / 3_600_000;
    laborHours += worked;
    if (shift.hourly_rate == null) laborComplete = false;
    else laborCost += worked * shift.hourly_rate;
  }

  const expenses = expenseTotalsByCategory(db, businessDate, businessDate);

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
      guests: live.reduce(
        (sum, order) => sum + (order.guest_count && order.guest_count > 0 ? order.guest_count : 1),
        0,
      ),
      guests_estimated: live.some((order) => !order.guest_count),
    },
    cost: {
      ingredient:
        summary.ingredient_cost_total === null ? null : money(summary.ingredient_cost_total),
      ingredient_coverage: summary.cost_coverage_status,
      known_cost_sales: money(summary.known_cost_net_item_sales),
      labor: money(laborCost),
      labor_hours: Math.round(laborHours * 100) / 100,
      labor_complete: laborComplete,
      expenses: expenses.map((row) => ({ name: row.name, amount: money(row.minor / minorFactor) })),
    },
    payments: summary.payment_methods.map((row) => ({
      method: row.method,
      count: row.count,
      total: money(row.total),
    })),
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
      on_time_minutes: KITCHEN_ON_TIME_MINUTES,
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
export async function syncOwnerReports(
  config: QrCloudConfig,
  signal: AbortSignal,
  nowInstant: Date = new Date(),
) {
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
  nextSyncAt =
    nowInstant.getTime() +
    (backfill.length > batch.length ? BACKFILL_INTERVAL_MS : SYNC_INTERVAL_MS);
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
