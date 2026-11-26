import type Database from 'better-sqlite3';

export type StaffDaySummary = { sales: number; bills: number; new_customers: number };

const MY_ORDER = '(o.user_id = @userId OR o.table_owner_user_id = @userId)';

/**
 * A staff member's own takings for `[start, end)`: bills paid in the window on orders they took
 * or on tables they owned when the order was placed. New customers are customer records whose
 * first-ever order was placed in the window on one of those orders.
 */
export function staffDaySummary(
  db: Database.Database,
  userId: string,
  start: string,
  end: string,
): StaffDaySummary {
  const params = { userId, start, end };
  const takings = db
    .prepare(
      `SELECT COALESCE(SUM(b.paid_amount), 0) AS sales, COUNT(*) AS bills
       FROM bills b JOIN orders o ON o.id = b.order_id
       WHERE ${MY_ORDER}
         AND b.paid_at >= @start AND b.paid_at < @end
         AND b.payment_status IN ('paid', 'partially_refunded', 'refunded')`,
    )
    .get(params) as { sales: number; bills: number };
  const { new_customers } = db
    .prepare(
      `SELECT COUNT(DISTINCT o.customer_id) AS new_customers
       FROM orders o
       WHERE ${MY_ORDER}
         AND o.customer_id IS NOT NULL
         AND o.status != 'cancelled'
         AND o.created_at >= @start AND o.created_at < @end
         AND NOT EXISTS (
           SELECT 1 FROM orders earlier
           WHERE earlier.customer_id = o.customer_id
             AND earlier.status != 'cancelled'
             AND earlier.created_at < @start
         )`,
    )
    .get(params) as { new_customers: number };
  return { sales: takings.sales, bills: takings.bills, new_customers };
}
