import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';
import type { ConnectorIdentity } from './connector-auth';
import { inTenant } from './tenant-scope';
import { branchesWithModule, moduleEnabled } from './modules';

export const MAX_REPORT_DAYS = 370;
const MAX_REPORT_BYTES = 128_000;
const DAY_MS = 86_400_000;

type Num = number | null | undefined;
interface DailyReport {
  v: number;
  business_date: string;
  currency: string;
  sales: { net: number; gross: number; refunds: number; discounts: number; orders: number; bills: number; cancelled_orders: number; guests: number; guests_estimated: boolean };
  cost: { ingredient: Num; ingredient_coverage: string; known_cost_sales: number; labor: number; labor_hours: number; labor_complete: boolean; expenses: { name: string; amount: number }[] };
  payments: { method: string; count: number; total: number }[];
  categories: { name: string | null; net: number; qty: number }[];
  items: { name: string; qty: number; net: number; image: string | null }[];
  hours: { sales: number; bills: number }[];
  tables: { count: number; occupied_minutes: number[] };
  kitchen: { timed: number; wait_minutes: number; prep_minutes: number; on_time: number; on_time_minutes: number };
  customers: { members: number; new_members: number; member_visits: number; repeat_members: number; promo_orders: number };
  staff: { on_duty: number };
}

const n = (value: Num) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

function totals(rows: DailyReport[]) {
  const sum = (pick: (row: DailyReport) => Num) => rows.reduce((acc, row) => acc + n(pick(row)), 0);
  const net = sum((r) => r.sales?.net);
  const knownCostSales = sum((r) => r.cost?.known_cost_sales);
  const ingredient = sum((r) => r.cost?.ingredient);
  const foodCost = knownCostSales > 0 ? (ingredient / knownCostSales) * net : null;
  const labor = sum((r) => r.cost?.labor);
  const expenses = sum((r) => r.cost?.expenses?.reduce((acc, e) => acc + n(e.amount), 0));
  const bills = sum((r) => r.sales?.bills);
  const orders = sum((r) => r.sales?.orders);
  const cancelled = sum((r) => r.sales?.cancelled_orders);
  let occupied = 0;
  let capacity = 0;
  for (const row of rows) {
    row.hours?.forEach((hour, index) => {
      if (!hour.bills || !row.tables?.count) return;
      occupied += n(row.tables.occupied_minutes?.[index]);
      capacity += row.tables.count * 60;
    });
  }
  const timed = sum((r) => r.kitchen?.timed);
  const visits = sum((r) => r.customers?.member_visits);
  const staffDays = sum((r) => r.staff?.on_duty);
  const profit = foodCost === null ? null : net - foodCost - labor - expenses;
  return {
    net: round(net),
    gross: round(sum((r) => r.sales?.gross)),
    refunds: round(sum((r) => r.sales?.refunds)),
    discounts: round(sum((r) => r.sales?.discounts)),
    bills,
    orders,
    cancelled_orders: cancelled,
    guests: sum((r) => r.sales?.guests),
    guests_estimated: rows.some((r) => r.sales?.guests_estimated),
    aov: bills ? round(net / bills) : 0,
    table_utilization: capacity ? round(occupied / capacity, 4) : null,
    food_cost: foodCost === null ? null : round(foodCost),
    food_cost_coverage: knownCostSales > 0 && net > 0 ? round(knownCostSales / net, 4) : 0,
    labor: round(labor),
    labor_complete: rows.every((r) => r.cost?.labor_complete !== false),
    expenses: round(expenses),
    profit: profit === null ? null : round(profit),
    margin: profit === null || !net ? null : round(profit / net, 4),
    kitchen_timed: timed,
    avg_wait_minutes: timed ? round(sum((r) => r.kitchen?.wait_minutes) / timed, 1) : null,
    avg_prep_minutes: timed ? round(sum((r) => r.kitchen?.prep_minutes) / timed, 1) : null,
    on_time_rate: timed ? round(sum((r) => r.kitchen?.on_time) / timed, 4) : null,
    on_time_minutes: rows.find((r) => r.kitchen?.on_time_minutes)?.kitchen?.on_time_minutes ?? 20,
    cancel_rate: orders + cancelled ? round(cancelled / (orders + cancelled), 4) : 0,
    new_members: sum((r) => r.customers?.new_members),
    member_visits: visits,
    repeat_members: sum((r) => r.customers?.repeat_members),
    promo_rate: orders ? round(sum((r) => r.customers?.promo_orders) / orders, 4) : 0,
    staff_days: staffDays,
    sales_per_staff_day: staffDays ? round(net / staffDays) : null,
    bills_per_staff_day: staffDays ? round(bills / staffDays, 1) : null,
  };
}

function merge<T>(rows: DailyReport[], pick: (row: DailyReport) => T[] | undefined, key: (entry: T) => string, add: (into: T | undefined, entry: T) => T) {
  const merged = new Map<string, T>();
  for (const row of rows) for (const entry of pick(row) ?? []) merged.set(key(entry), add(merged.get(key(entry)), entry));
  return [...merged.values()];
}

/** The owner dashboard for a date range, compared with the same number of days just before it. */
export async function ownerDashboard(sql: Sql, tenantId: string, input: { from: string; to: string; branchId: string | null }) {
  const allowed = input.branchId ? [input.branchId] : await branchesWithModule(sql, tenantId, 'reports');
  const days = Math.round((dateMs(input.to) - dateMs(input.from)) / DAY_MS) + 1;
  const prevTo = isoDate(dateMs(input.from) - DAY_MS);
  const prevFrom = isoDate(dateMs(input.from) - days * DAY_MS);
  const branches = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM branches WHERE tenant_id = ${tenantId} AND id = ANY(${allowed}::uuid[]) ORDER BY created_at, name`;
  const rows = await sql<{ branch_id: string; business_date: string; report: DailyReport; updated_at: Date }[]>`
    SELECT branch_id, to_char(business_date, 'YYYY-MM-DD') AS business_date, report, updated_at
    FROM branch_daily_reports
    WHERE tenant_id = ${tenantId} AND business_date BETWEEN ${prevFrom} AND ${input.to}
      AND branch_id = ANY(${allowed}::uuid[])`;
  const current = [...rows].filter((r) => r.business_date >= input.from);
  const previous = rows.filter((r) => r.business_date < input.from);
  const reports = current.map((r) => r.report);

  const daily = Array.from({ length: days }, (_, index) => {
    const date = isoDate(dateMs(input.from) + index * DAY_MS);
    const prevDate = isoDate(dateMs(prevFrom) + index * DAY_MS);
    const on = (list: typeof current, d: string) => list.filter((r) => r.business_date === d).reduce((acc, r) => acc + n(r.report.sales?.net), 0);
    return { date, net: round(on(current, date)), prev_net: round(on(previous, prevDate)) };
  });
  const hours = Array.from({ length: 24 }, (_, hour) => {
    let sales = 0, bills = 0, occupied = 0, capacity = 0;
    for (const report of reports) {
      sales += n(report.hours?.[hour]?.sales);
      bills += n(report.hours?.[hour]?.bills);
      if (report.hours?.[hour]?.bills && report.tables?.count) {
        occupied += n(report.tables.occupied_minutes?.[hour]);
        capacity += report.tables.count * 60;
      }
    }
    return { hour, sales: round(sales), bills, utilization: capacity ? round(occupied / capacity, 4) : null };
  });
  const latest = new Map<string, DailyReport>();
  for (const row of [...current].sort((a, b) => a.business_date.localeCompare(b.business_date))) latest.set(row.branch_id, row.report);

  const month = input.from.slice(0, 7) === input.to.slice(0, 7) ? `${input.from.slice(0, 7)}-01` : null;
  const [target] = month
    ? await sql<{ target: string | null }[]>`
        SELECT sum(target)::text AS target FROM branch_sales_targets
        WHERE tenant_id = ${tenantId} AND month = ${month} AND branch_id = ANY(${allowed}::uuid[])`
    : [];
  let monthNet: number | null = null;
  if (month) {
    const [row] = await sql<{ net: string | null }[]>`
      SELECT sum((report->'sales'->>'net')::numeric)::text AS net FROM branch_daily_reports
      WHERE tenant_id = ${tenantId} AND date_trunc('month', business_date) = ${month}::date
        AND branch_id = ANY(${allowed}::uuid[])`;
    monthNet = row?.net ? round(Number(row.net)) : 0;
  }

  return {
    range: { from: input.from, to: input.to, prev_from: prevFrom, prev_to: prevTo, days },
    currency: reports[0]?.currency ?? 'THB',
    branches: branches.map((b) => {
      const mine = current.filter((r) => r.branch_id === b.id);
      return {
        id: b.id,
        name: b.name,
        net: round(mine.reduce((acc, r) => acc + n(r.report.sales?.net), 0)),
        reported_days: mine.length,
        last_update: rows.filter((r) => r.branch_id === b.id).reduce<Date | null>((acc, r) => (!acc || r.updated_at > acc ? r.updated_at : acc), null),
      };
    }),
    current: totals(reports),
    previous: totals(previous.map((r) => r.report)),
    members: [...latest.values()].reduce((acc, r) => acc + n(r.customers?.members), 0),
    daily,
    hours,
    categories: merge(reports, (r) => r.categories, (c) => c.name ?? '', (into, c) => ({ name: c.name, net: round(n(into?.net) + n(c.net)), qty: n(into?.qty) + n(c.qty) })).sort((a, b) => b.net - a.net),
    items: merge(reports, (r) => r.items, (i) => i.name, (into, i) => ({ name: i.name, image: into?.image ?? i.image, net: round(n(into?.net) + n(i.net)), qty: n(into?.qty) + n(i.qty) })).sort((a, b) => b.net - a.net).slice(0, 50),
    payments: merge(reports, (r) => r.payments, (p) => p.method, (into, p) => ({ method: p.method, count: n(into?.count) + n(p.count), total: round(n(into?.total) + n(p.total)) })).sort((a, b) => b.total - a.total),
    expenses: merge(reports, (r) => r.cost?.expenses, (e) => e.name, (into, e) => ({ name: e.name, amount: round(n(into?.amount) + n(e.amount)) })).sort((a, b) => b.amount - a.amount),
    target: month ? { month: month.slice(0, 7), target: target?.target ? Number(target.target) : null, achieved: monthNet } : null,
  };
}

export async function setSalesTarget(sql: Sql, tenantId: string, branchId: string, month: string, target: number | null) {
  if (target === null) {
    await sql`DELETE FROM branch_sales_targets WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND month = ${`${month}-01`}`;
    return;
  }
  await sql`
    INSERT INTO branch_sales_targets (tenant_id, branch_id, month, target) VALUES (${tenantId}, ${branchId}, ${`${month}-01`}, ${target})
    ON CONFLICT (tenant_id, branch_id, month) DO UPDATE SET target = excluded.target, updated_at = now()`;
}

const BusinessDate = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

/** Connector side: the POS publishes aggregated business days; a later copy of a day replaces the earlier one. */
export function connectorReports({ sql, authorize }: { sql: Sql; authorize(request: Request): Promise<ConnectorIdentity | null> }) {
  return new Elysia().post('/api/v1/connectors/reports', async ({ request, body }) => {
    const scope = await authorize(request);
    if (!scope) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    if (!(await moduleEnabled(sql, scope.tenantId, scope.branchId, 'reports')))
      return new Response(JSON.stringify({ error: 'module_disabled', code: 'module_disabled' }), { status: 403 });
    const today = Date.now();
    const accepted = body.reports.filter((report) => {
      const at = dateMs(report.business_date);
      return report.v === 1 && Number.isFinite(at) && at <= today + 2 * DAY_MS && at >= today - MAX_REPORT_DAYS * DAY_MS
        && JSON.stringify(report).length <= MAX_REPORT_BYTES;
    });
    await inTenant(sql, scope, async (tx) => {
      for (const report of accepted) {
        await tx`
          INSERT INTO branch_daily_reports (tenant_id, branch_id, business_date, report)
          VALUES (${scope.tenantId}, ${scope.branchId}, ${report.business_date}, ${tx.json(report as never)})
          ON CONFLICT (tenant_id, branch_id, business_date) DO UPDATE SET report = excluded.report, updated_at = now()`;
      }
    });
    return { accepted: accepted.length, rejected: body.reports.length - accepted.length };
  }, {
    body: t.Object({
      reports: t.Array(t.Object({ v: t.Number(), business_date: BusinessDate }, { additionalProperties: true }), { maxItems: 40 }),
    }),
  });
}
