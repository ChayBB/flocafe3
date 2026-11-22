import type { getDatabase } from '../db';
import { dayBoundsInTimezone, parseDbTimestamp, tenantBusinessDayStartTime } from '../db';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import { GUEST_USER_ID } from '../lib/guest-order';
import { attendanceReport } from './attendance';
import {
  buildDailySalesExportDataset,
  DAILY_SALES_EXPORT_MAX_RANGE_DAYS,
  parseValidBusinessDate,
  resolveExportTimezone,
  type DailySalesCostStatus,
} from './daily-sales-export';
import {
  billSalesByLocalHour,
  expenseTotalsByCategory,
  KITCHEN_ON_TIME_MINUTES,
  localHourReader,
  summarizeKitchen,
  tableOccupiedMinutes,
} from './owner-metrics';
import { getTenantCurrency } from './refund';
import { roundCurrencyCost } from './supplies';

type Db = ReturnType<typeof getDatabase>;

export const EXECUTIVE_COMPARE_MODES = [
  'previous_period',
  'previous_month',
  'previous_year',
  'none',
] as const;
export type ExecutiveCompareMode = (typeof EXECUTIVE_COMPARE_MODES)[number];

export const EXECUTIVE_SUMMARY_MAX_RANGE_DAYS = DAILY_SALES_EXPORT_MAX_RANGE_DAYS;
const TOP_ITEMS = 5;
const TOP_STAFF = 10;
const DAY_MS = 86_400_000;

export class ExecutiveSummaryValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ExecutiveSummaryValidationError';
  }
}

export interface ExecutiveRange {
  startDate: string;
  endDate: string;
  days: number;
}

const pad = (value: number) => String(value).padStart(2, '0');
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const msDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => msDate(dateMs(date) + days * DAY_MS);
const inclusiveDays = (start: string, end: string) =>
  Math.round((dateMs(end) - dateMs(start)) / DAY_MS) + 1;
const lastDayOfMonth = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
const round1 = (value: number) => Math.round(value * 10) / 10;
const percentOf = (part: number, whole: number) =>
  whole > 0 ? round1((part / whole) * 100) : null;
const percentChange = (current: number, previous: number | null | undefined) =>
  previous !== null && previous !== undefined && previous > 0
    ? round1(((current - previous) / previous) * 100)
    : null;
const pointChange = (current: number | null, previous: number | null | undefined) =>
  current !== null && previous !== null && previous !== undefined
    ? round1(current - previous)
    : null;

function shiftMonths(date: string, months: number, toMonthEnd: boolean): string {
  const [year, month, day] = date.split('-').map(Number);
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12;
  const last = lastDayOfMonth(nextYear, nextMonth);
  return `${nextYear}-${pad(nextMonth + 1)}-${pad(toMonthEnd ? last : Math.min(day, last))}`;
}

function requireDate(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !parseValidBusinessDate(value)
  )
    throw new ExecutiveSummaryValidationError(`${field} must be a valid YYYY-MM-DD date`);
  return value;
}

/** Validates the requested business-date range and derives the comparison range for `compare`. */
export function resolveExecutiveRanges(
  startValue: unknown,
  endValue: unknown,
  compareValue: unknown,
): { current: ExecutiveRange; compare: ExecutiveRange | null; mode: ExecutiveCompareMode } {
  const startDate = requireDate(startValue, 'start_date');
  const endDate = requireDate(endValue, 'end_date');
  if (startDate > endDate)
    throw new ExecutiveSummaryValidationError('start_date must be on or before end_date');
  const days = inclusiveDays(startDate, endDate);
  if (days > EXECUTIVE_SUMMARY_MAX_RANGE_DAYS)
    throw new ExecutiveSummaryValidationError(
      `The range must not exceed ${EXECUTIVE_SUMMARY_MAX_RANGE_DAYS} days`,
    );
  const mode = (
    compareValue === undefined || compareValue === '' ? 'previous_period' : compareValue
  ) as ExecutiveCompareMode;
  if (!EXECUTIVE_COMPARE_MODES.includes(mode))
    throw new ExecutiveSummaryValidationError(
      `compare must be one of ${EXECUTIVE_COMPARE_MODES.join(', ')}`,
    );
  const current = { startDate, endDate, days };
  if (mode === 'none') return { current, compare: null, mode };
  if (mode === 'previous_period') {
    const compareEnd = addDays(startDate, -1);
    const compareStart = addDays(compareEnd, -(days - 1));
    return { current, compare: { startDate: compareStart, endDate: compareEnd, days }, mode };
  }
  const months = mode === 'previous_month' ? -1 : -12;
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const wholeMonths = startDate.endsWith('-01') && endDay === lastDayOfMonth(endYear, endMonth - 1);
  const compareStart = shiftMonths(startDate, months, false);
  const compareEnd = shiftMonths(endDate, months, wholeMonths);
  return {
    current,
    compare: {
      startDate: compareStart,
      endDate: compareEnd,
      days: inclusiveDays(compareStart, compareEnd),
    },
    mode,
  };
}

interface Context {
  db: Db;
  timezone: string;
  dayStart: string;
  minorFactor: number;
  fractionDigits: number;
  tableCount: number;
  categoryOf: Map<string, string | null>;
  localHour: (instant: Date) => number;
  localSlot: (instant: Date) => string;
  nowMs: number;
}

interface OrderRow {
  id: number;
  status: string;
  type: string;
  table_id: string | null;
  customer_id: string | null;
  user_id: string | null;
  guest_count: number | null;
  total: number | null;
  created_at: string;
  cooking_started_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  paid_at: string | null;
}

function localSlotReader(timezone: string): (instant: Date) => string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (instant: Date) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${pad(Number(parts.hour) % 24)}`;
  };
}

function periodMetrics(ctx: Context, range: ExecutiveRange) {
  const { db } = ctx;
  const money = (value: number) => roundCurrencyCost(value, ctx.fractionDigits);
  const start = dayBoundsInTimezone(range.startDate, ctx.timezone, ctx.dayStart)[0];
  const end = dayBoundsInTimezone(range.endDate, ctx.timezone, ctx.dayStart)[1];
  const dataset = buildDailySalesExportDataset({ from: range.startDate, to: range.endDate }, db);
  const summary = dataset.summary;
  const sales = money(summary.net_collected);
  const bills = summary.paid_bill_count;

  const orders = db
    .prepare(
      `SELECT o.id, o.status, o.type, o.table_id, o.customer_id, o.user_id, o.guest_count, o.total,
              o.created_at, o.cooking_started_at, o.ready_at, o.completed_at,
              (SELECT MAX(b.paid_at) FROM bills b WHERE b.order_id = o.id) AS paid_at
       FROM orders o WHERE o.created_at >= ? AND o.created_at < ?`,
    )
    .all(start, end) as OrderRow[];
  const live = orders.filter((order) => order.status !== 'cancelled');
  const cancelled = orders.length - live.length;

  const kitchen = summarizeKitchen(live);
  const ordersByHour = Array.from({ length: 24 }, () => 0);
  for (const order of live) ordersByHour[ctx.localHour(parseDbTimestamp(order.created_at))] += 1;

  let tables = null;
  if (ctx.tableCount > 0) {
    const occupied = tableOccupiedMinutes(
      live,
      ctx.localSlot,
      Math.min(parseDbTimestamp(end).getTime(), ctx.nowMs),
    );
    const slots = new Set<string>(occupied.keys());
    for (const order of live) slots.add(ctx.localSlot(parseDbTimestamp(order.created_at)));
    const capacityByHour = Array.from({ length: 24 }, () => 0);
    const occupiedByHour = Array.from({ length: 24 }, () => 0);
    const tradingDates = new Set<string>();
    for (const slot of slots) {
      const hour = Number(slot.slice(-2));
      capacityByHour[hour] += ctx.tableCount * 60;
      tradingDates.add(slot.slice(0, 10));
    }
    for (const [slot, minutes] of occupied) occupiedByHour[Number(slot.slice(-2))] += minutes;
    const totalCapacity = capacityByHour.reduce((sum, value) => sum + value, 0);
    const totalOccupied = occupiedByHour.reduce((sum, value) => sum + value, 0);
    const byHour = capacityByHour
      .map((capacity, hour) => ({
        hour,
        percent:
          capacity > 0 ? Math.min(100, round1((occupiedByHour[hour] / capacity) * 100)) : null,
      }))
      .filter((slot): slot is { hour: number; percent: number } => slot.percent !== null);
    const seatings = live.filter((order) => order.table_id).length;
    tables = {
      count: ctx.tableCount,
      utilisationPercent:
        totalCapacity > 0 ? Math.min(100, round1((totalOccupied / totalCapacity) * 100)) : null,
      byHour,
      peakHours: [...byHour]
        .filter((slot) => slot.percent > 0)
        .sort((a, b) => b.percent - a.percent || a.hour - b.hour)
        .slice(0, 3)
        .map((slot) => slot.hour),
      seatingsPerTablePerDay:
        tradingDates.size > 0 ? round1(seatings / ctx.tableCount / tradingDates.size) : null,
    };
  }

  const categories = new Map<string, { name: string | null; sales: number; quantity: number }>();
  for (const item of dataset.items) {
    const name = ctx.categoryOf.get(item.product_id) ?? null;
    const key = name ?? '';
    const category = categories.get(key) ?? { name, sales: 0, quantity: 0 };
    category.sales += item.net_item_sales;
    category.quantity += item.quantity;
    categories.set(key, category);
  }
  const itemSales = dataset.items.reduce((sum, item) => sum + item.net_item_sales, 0);
  const itemQuantity = dataset.items.reduce((sum, item) => sum + item.quantity, 0);
  const itemRow = (item: (typeof dataset.items)[number]) => ({
    productId: item.product_id,
    name: item.product_name,
    quantity: item.quantity,
    sales: money(item.net_item_sales),
    salesPercent: percentOf(item.net_item_sales, itemSales),
    quantityPercent: percentOf(item.quantity, itemQuantity),
  });

  const members = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS joined
       FROM customers WHERE is_active = 1 AND created_at < ?`,
    )
    .get(start, end) as { total: number; joined: number | null };
  const returning = db
    .prepare(
      `SELECT COUNT(DISTINCT o.customer_id) AS n FROM orders o
       WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'cancelled' AND o.customer_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM orders p WHERE p.customer_id = o.customer_id
                     AND p.status <> 'cancelled' AND p.created_at < ?)`,
    )
    .get(start, end, start) as { n: number };
  const memberOrders = live.filter((order) => order.customer_id).length;

  const attendance = attendanceReport(db, range.startDate, range.endDate);
  const staffSales = new Map<string, { orders: number; sales: number }>();
  for (const order of live) {
    if (!order.user_id || order.user_id === GUEST_USER_ID) continue;
    const row = staffSales.get(order.user_id) ?? { orders: 0, sales: 0 };
    row.orders += 1;
    row.sales += Number(order.total || 0);
    staffSales.set(order.user_id, row);
  }
  const userNames = new Map(
    (
      db.prepare('SELECT id, name, role FROM users').all() as {
        id: string;
        name: string;
        role: string;
      }[]
    ).map((user) => [user.id, user]),
  );
  const staffIds = new Set<string>([
    ...staffSales.keys(),
    ...attendance.filter((member) => member.total_hours > 0).map((member) => member.user_id),
  ]);
  const staff = [...staffIds]
    .map((userId) => {
      const totals = staffSales.get(userId) ?? { orders: 0, sales: 0 };
      const worked = attendance.find((member) => member.user_id === userId);
      const hours = worked?.total_hours ?? 0;
      return {
        userId,
        name: userNames.get(userId)?.name ?? userId,
        role: userNames.get(userId)?.role ?? null,
        orders: totals.orders,
        sales: money(totals.sales),
        averageOrderValue: totals.orders > 0 ? money(totals.sales / totals.orders) : null,
        hours,
        salesPerHour: hours > 0 ? money(totals.sales / hours) : null,
        wage: worked ? money(worked.total_wage) : 0,
      };
    })
    .sort((a, b) => b.sales - a.sales || b.hours - a.hours)
    .slice(0, TOP_STAFF);
  const workedStaff = attendance.filter((member) => member.total_hours > 0);
  const labour = {
    cost: money(attendance.reduce((sum, member) => sum + member.total_wage, 0)),
    hours: round1(attendance.reduce((sum, member) => sum + member.total_hours, 0)),
    complete: workedStaff.every((member) => member.hourly_rate !== null),
    openShifts: attendance.reduce((sum, member) => sum + member.open_shifts, 0),
  };

  const expenseRows = expenseTotalsByCategory(db, range.startDate, range.endDate);
  const expenses = {
    total: money(expenseRows.reduce((sum, row) => sum + row.minor, 0) / ctx.minorFactor),
    categories: expenseRows.map((row) => ({
      name: row.name,
      amount: money(row.minor / ctx.minorFactor),
    })),
  };
  const foodCost =
    summary.ingredient_cost_total === null ? null : money(summary.ingredient_cost_total);
  const salesExTax = money(summary.net_collected - summary.tax_total);

  return {
    range,
    sales,
    bills,
    averageOrderValue: bills > 0 ? money(summary.net_collected / bills) : 0,
    daily: dataset.daily.map((day) => ({
      date: day.business_date,
      sales: money(day.net_collected),
      bills: day.paid_bill_count,
    })),
    orders: orders.length,
    liveOrders: live.length,
    cancelled,
    cancelPercent: percentOf(cancelled, orders.length),
    guests: live.reduce(
      (sum, order) => sum + (order.guest_count && order.guest_count > 0 ? order.guest_count : 1),
      0,
    ),
    guestsEstimated: live.some((order) => !order.guest_count),
    kitchen: {
      timedOrders: kitchen.timed,
      avgWaitMinutes: kitchen.timed > 0 ? round1(kitchen.wait_minutes / kitchen.timed) : null,
      avgPrepMinutes: kitchen.timed > 0 ? round1(kitchen.prep_minutes / kitchen.timed) : null,
      onTimePercent: percentOf(kitchen.on_time, kitchen.timed),
    },
    ordersByHour,
    tables,
    categories: [...categories.values()]
      .map((row) => ({
        name: row.name,
        sales: money(row.sales),
        quantity: row.quantity,
        salesPercent: percentOf(row.sales, itemSales),
      }))
      .sort((a, b) => b.sales - a.sales),
    topItems: {
      byRevenue: [...dataset.items]
        .sort((a, b) => b.net_item_sales - a.net_item_sales || b.quantity - a.quantity)
        .slice(0, TOP_ITEMS)
        .map(itemRow),
      byQuantity: [...dataset.items]
        .sort((a, b) => b.quantity - a.quantity || b.net_item_sales - a.net_item_sales)
        .slice(0, TOP_ITEMS)
        .map(itemRow),
    },
    customers: {
      totalMembers: members.total,
      newMembers: members.joined ?? 0,
      memberVisits: new Set(live.map((order) => order.customer_id).filter(Boolean)).size,
      returningMembers: returning.n,
      memberOrderPercent: percentOf(memberOrders, live.length),
    },
    staff,
    financial: {
      sales,
      tax: money(summary.tax_total),
      salesExTax,
      foodCost,
      foodCostPercent:
        foodCost !== null ? percentOf(foodCost, summary.known_cost_net_item_sales) : null,
      grossMarginPercent: summary.gross_margin_percent,
      costStatus: summary.cost_coverage_status as DailySalesCostStatus,
      labour,
      expenses,
      estimatedProfit: money(salesExTax - (foodCost ?? 0) - labour.cost - expenses.total),
    },
  };
}

type Period = ReturnType<typeof periodMetrics>;

function bucketTrend(daily: Period['daily'], by: 'week' | 'month') {
  const buckets: {
    label: string;
    startDate: string;
    endDate: string;
    sales: number;
    bills: number;
  }[] = [];
  daily.forEach((day, index) => {
    const key = by === 'week' ? String(Math.floor(index / 7)) : day.date.slice(0, 7);
    const last = buckets[buckets.length - 1];
    if (last && last.label === key) {
      last.endDate = day.date;
      last.sales += day.sales;
      last.bills += day.bills;
    } else
      buckets.push({
        label: key,
        startDate: day.date,
        endDate: day.date,
        sales: day.sales,
        bills: day.bills,
      });
  });
  return buckets.map(({ label: _label, ...bucket }) => bucket);
}

export type ExecutiveInsight = {
  code: string;
  tone: 'positive' | 'negative' | 'action';
  params: Record<string, string | number>;
};

function buildInsights(current: Period, previous: Period | null, includeFinancials: boolean) {
  const insights: ExecutiveInsight[] = [];
  const salesChange = previous ? percentChange(current.sales, previous.sales) : null;
  if (salesChange !== null && salesChange !== 0)
    insights.push({
      code: salesChange > 0 ? 'salesUp' : 'salesDown',
      tone: salesChange > 0 ? 'positive' : 'negative',
      params: { percent: Math.abs(salesChange) },
    });
  const topItem = current.topItems.byRevenue[0];
  if (topItem) insights.push({ code: 'topItem', tone: 'positive', params: { name: topItem.name } });
  const topCategory = current.categories[0];
  if (topCategory?.name && topCategory.salesPercent !== null)
    insights.push({
      code: 'topCategory',
      tone: 'positive',
      params: { name: topCategory.name, percent: topCategory.salesPercent },
    });
  const peakHour = current.ordersByHour.reduce(
    (best, count, hour) => (count > best.count ? { hour, count } : best),
    { hour: -1, count: 0 },
  );
  if (peakHour.hour >= 0)
    insights.push({ code: 'peakHour', tone: 'action', params: { hour: peakHour.hour } });
  const aovChange = previous
    ? percentChange(current.averageOrderValue, previous.averageOrderValue)
    : null;
  if (aovChange !== null && aovChange <= -5)
    insights.push({ code: 'aovDown', tone: 'action', params: { percent: Math.abs(aovChange) } });
  if (
    current.kitchen.timedOrders >= 5 &&
    current.kitchen.onTimePercent !== null &&
    current.kitchen.onTimePercent < 80
  )
    insights.push({
      code: 'onTimeLow',
      tone: 'action',
      params: { percent: current.kitchen.onTimePercent, minutes: KITCHEN_ON_TIME_MINUTES },
    });
  if (current.orders >= 10 && current.cancelPercent !== null && current.cancelPercent >= 5)
    insights.push({
      code: 'cancelHigh',
      tone: 'action',
      params: { percent: current.cancelPercent },
    });
  if (current.tables?.utilisationPercent != null && current.tables.utilisationPercent < 30)
    insights.push({
      code: 'tablesQuiet',
      tone: 'action',
      params: { percent: current.tables.utilisationPercent },
    });
  if (
    current.liveOrders >= 20 &&
    current.customers.memberOrderPercent !== null &&
    current.customers.memberOrderPercent < 20
  )
    insights.push({
      code: 'membersLow',
      tone: 'action',
      params: { percent: current.customers.memberOrderPercent },
    });
  if (includeFinancials) {
    const financial = current.financial;
    if (financial.foodCostPercent !== null && financial.foodCostPercent > 35)
      insights.push({
        code: 'foodCostHigh',
        tone: 'action',
        params: { percent: financial.foodCostPercent },
      });
    if (current.topItems.byRevenue.length > 0 && financial.costStatus !== 'known')
      insights.push({ code: 'recipesMissing', tone: 'action', params: {} });
    if (!financial.labour.complete)
      insights.push({ code: 'hourlyRatesMissing', tone: 'action', params: {} });
  }
  return insights;
}

/** Owner/manager summary for `range`, compared with `compare`. Financial figures are left out unless allowed. */
export function buildExecutiveSummary(
  db: Db,
  ranges: ReturnType<typeof resolveExecutiveRanges>,
  options: { includeFinancials: boolean; now?: Date },
) {
  const timezone = resolveExportTimezone(db);
  const currency = getTenantCurrency(db);
  const ctx: Context = {
    db,
    timezone,
    dayStart: tenantBusinessDayStartTime(db),
    minorFactor: getCurrencyMinorUnitFactor(currency),
    fractionDigits: getCurrencyFractionDigits(currency),
    tableCount: (
      db.prepare('SELECT COUNT(*) AS n FROM tables WHERE is_active = 1').get() as { n: number }
    ).n,
    categoryOf: new Map(
      (
        db
          .prepare(
            'SELECT p.id, c.name FROM products p LEFT JOIN categories c ON c.id = p.category_id',
          )
          .all() as { id: string; name: string | null }[]
      ).map((row) => [row.id, row.name]),
    ),
    localHour: localHourReader(timezone),
    localSlot: localSlotReader(timezone),
    nowMs: (options.now ?? new Date()).getTime(),
  };
  const current = periodMetrics(ctx, ranges.current);
  const previous = ranges.compare ? periodMetrics(ctx, ranges.compare) : null;
  const fin = options.includeFinancials;
  const money = (value: number) => roundCurrencyCost(value, ctx.fractionDigits);

  const amountKpi = (value: number, prior: number | undefined) => ({
    value,
    previous: prior ?? null,
    changePercent: previous ? percentChange(value, prior) : null,
  });
  const rateKpi = (value: number | null, prior: number | null | undefined) => ({
    value,
    previous: prior ?? null,
    changePoints: previous ? pointChange(value, prior) : null,
  });
  const operations = (period: Period) => ({
    orders: period.orders,
    cancelledOrders: period.cancelled,
    cancelPercent: period.cancelPercent,
    ...period.kitchen,
  });
  const hourlyBounds = dayBoundsInTimezone(ranges.current.endDate, timezone, ctx.dayStart);
  const hourly = billSalesByLocalHour(
    db,
    hourlyBounds[0],
    hourlyBounds[1],
    ctx.localHour,
    ctx.minorFactor,
  );

  return {
    range: ranges.current,
    compare: ranges.compare ? { mode: ranges.mode, ...ranges.compare } : null,
    currency,
    financialsIncluded: fin,
    kpis: {
      sales: amountKpi(current.sales, previous?.sales),
      bills: amountKpi(current.bills, previous?.bills),
      guests: {
        ...amountKpi(current.guests, previous?.guests),
        estimated: current.guestsEstimated,
      },
      averageOrderValue: amountKpi(current.averageOrderValue, previous?.averageOrderValue),
      tableUtilisation: current.tables
        ? rateKpi(current.tables.utilisationPercent, previous?.tables?.utilisationPercent)
        : null,
      grossMargin:
        fin && current.financial.costStatus !== 'unknown'
          ? {
              ...rateKpi(
                current.financial.grossMarginPercent,
                previous?.financial.grossMarginPercent,
              ),
              costStatus: current.financial.costStatus,
            }
          : null,
    },
    trend: {
      daily: { current: current.daily, previous: previous?.daily ?? [] },
      weekly: {
        current: bucketTrend(current.daily, 'week'),
        previous: previous ? bucketTrend(previous.daily, 'week') : [],
      },
      monthly: {
        current: bucketTrend(current.daily, 'month'),
        previous: previous ? bucketTrend(previous.daily, 'month') : [],
      },
    },
    categories: current.categories,
    topItems: current.topItems,
    operations: {
      ...operations(current),
      onTimeMinutes: KITCHEN_ON_TIME_MINUTES,
      previous: previous ? operations(previous) : null,
    },
    tables: current.tables,
    customers: {
      guests: current.guests,
      guestsEstimated: current.guestsEstimated,
      ...current.customers,
      previous: previous ? { guests: previous.guests, ...previous.customers } : null,
    },
    financial: fin
      ? {
          ...current.financial,
          previous: previous
            ? {
                sales: previous.financial.sales,
                foodCost: previous.financial.foodCost,
                labour: previous.financial.labour.cost,
                expenses: previous.financial.expenses.total,
                estimatedProfit: previous.financial.estimatedProfit,
              }
            : null,
        }
      : null,
    hourly: {
      date: ranges.current.endDate,
      hours: hourly.map((slot, hour) => ({ hour, sales: money(slot.sales), bills: slot.bills })),
    },
    staff: current.staff.map(({ wage, ...row }) => (fin ? { ...row, wage } : row)),
    insights: buildInsights(current, previous, fin),
  };
}

export type ExecutiveSummary = ReturnType<typeof buildExecutiveSummary>;
