import type { getDatabase } from '../db';
import { parseDbTimestamp } from '../db';

type Db = ReturnType<typeof getDatabase>;

export const KITCHEN_ON_TIME_MINUTES = 20;
const MAX_KITCHEN_MINUTES = 240;
const TABLE_STEP_MINUTES = 5;
const MAX_TABLE_SPAN_MS = 6 * 3_600_000;

/** Minutes from `from` to `to`, or null when either is missing or the span is implausible for a kitchen ticket. */
export function kitchenMinutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const minutes = (parseDbTimestamp(to).getTime() - parseDbTimestamp(from).getTime()) / 60_000;
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= MAX_KITCHEN_MINUTES
    ? minutes
    : null;
}

/** Store-local hour (0-23) of an instant. */
export function localHourReader(timezone: string): (instant: Date) => number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (instant: Date) => {
    const hour = Number(
      formatter.formatToParts(instant).find((part) => part.type === 'hour')?.value,
    );
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour % 24 : 0;
  };
}

export interface KitchenTimedOrder {
  created_at: string;
  cooking_started_at: string | null;
  ready_at: string | null;
}

/** Summed waiting and preparation minutes plus the on-time count for orders with complete kitchen timestamps. */
export function summarizeKitchen(orders: KitchenTimedOrder[]) {
  const kitchen = { timed: 0, wait_minutes: 0, prep_minutes: 0, on_time: 0 };
  for (const order of orders) {
    const wait = kitchenMinutesBetween(order.created_at, order.cooking_started_at);
    const prep = kitchenMinutesBetween(order.cooking_started_at, order.ready_at);
    const total = kitchenMinutesBetween(order.created_at, order.ready_at);
    if (wait === null || prep === null || total === null) continue;
    kitchen.timed += 1;
    kitchen.wait_minutes += wait;
    kitchen.prep_minutes += prep;
    if (total <= KITCHEN_ON_TIME_MINUTES) kitchen.on_time += 1;
  }
  return kitchen;
}

export interface TableSpanOrder {
  table_id: string | null;
  created_at: string;
  completed_at: string | null;
  paid_at: string | null;
}

/**
 * Occupied table-minutes per slot. Overlapping orders on one table count once, an order still open
 * runs until `endMs`, and a single seating is capped at six hours.
 */
export function tableOccupiedMinutes<K>(
  orders: TableSpanOrder[],
  slotOf: (instant: Date) => K,
  endMs: number,
): Map<K, number> {
  const byTable = new Map<string, [number, number][]>();
  for (const order of orders) {
    if (!order.table_id) continue;
    const from = parseDbTimestamp(order.created_at).getTime();
    const closedAt = order.completed_at ?? order.paid_at;
    const to = closedAt ? parseDbTimestamp(closedAt).getTime() : endMs;
    if (!(to > from)) continue;
    const spans = byTable.get(order.table_id) ?? [];
    spans.push([from, Math.min(to, from + MAX_TABLE_SPAN_MS)]);
    byTable.set(order.table_id, spans);
  }
  const occupied = new Map<K, number>();
  for (const spans of byTable.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [from, to] of spans) {
      for (let at = Math.max(from, cursor); at < to; at += TABLE_STEP_MINUTES * 60_000) {
        const slot = slotOf(new Date(at));
        occupied.set(slot, (occupied.get(slot) ?? 0) + TABLE_STEP_MINUTES);
      }
      cursor = Math.max(cursor, to);
    }
  }
  return occupied;
}

/** Collected sales and bill counts per store-local hour, net of refunds issued in the same window. */
export function billSalesByLocalHour(
  db: Db,
  start: string,
  end: string,
  localHour: (instant: Date) => number,
  minorFactor: number,
): { sales: number; bills: number }[] {
  const hours = Array.from({ length: 24 }, () => ({ sales: 0, bills: 0 }));
  for (const bill of db
    .prepare('SELECT paid_at, paid_amount FROM bills WHERE paid_at >= ? AND paid_at < ?')
    .all(start, end) as { paid_at: string; paid_amount: number | null }[]) {
    const slot = hours[localHour(parseDbTimestamp(bill.paid_at))];
    slot.sales += Number(bill.paid_amount || 0);
    slot.bills += 1;
  }
  for (const refund of db
    .prepare(
      'SELECT created_at, amount_cents FROM refunds WHERE created_at >= ? AND created_at < ?',
    )
    .all(start, end) as { created_at: string; amount_cents: number }[])
    hours[localHour(parseDbTimestamp(refund.created_at))].sales -=
      refund.amount_cents / minorFactor;
  return hours;
}

/** Live expense totals per category for business dates `from`..`to`, inclusive, in minor units. */
export function expenseTotalsByCategory(
  db: Db,
  from: string,
  to: string,
): { name: string; minor: number }[] {
  return db
    .prepare(
      `SELECT category_name AS name, SUM(amount_minor) AS minor FROM expenses e
       WHERE incurred_on >= ? AND incurred_on <= ? AND voided_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM expenses r WHERE r.replaces_expense_id = e.id)
       GROUP BY category_name ORDER BY minor DESC`,
    )
    .all(from, to) as { name: string; minor: number }[];
}
