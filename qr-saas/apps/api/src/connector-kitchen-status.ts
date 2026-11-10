import type { Sql } from 'postgres';

export const kitchenStatuses = ['pending', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type KitchenStatus = typeof kitchenStatuses[number];

const progress: KitchenStatus[] = ['pending', 'preparing', 'ready', 'served'];

/** The order-level status the guest sees: the least advanced live item, or cancelled when none is live. */
export function orderStatusOf(statuses: KitchenStatus[]): 'pos_accepted' | 'preparing' | 'ready' | 'served' | 'cancelled' {
  const live = statuses.filter((status) => status !== 'cancelled');
  if (!live.length) return 'cancelled';
  const least = progress[Math.min(...live.map((status) => progress.indexOf(status)))];
  return least === 'pending' ? 'pos_accepted' : least;
}

/**
 * Records the POS kitchen status of each line of an acknowledged order. Lines are positional, in
 * the same `order_items.id` order the connector read them; a count mismatch applies the order's
 * overall stage to every line rather than guessing which line is which.
 */
export async function recordKitchenStatus(
  sql: Sql,
  { tenantId, branchId, installationId }: { tenantId: string; branchId: string; installationId: string | null },
  input: { order_id: string; statuses: KitchenStatus[] },
): Promise<'updated' | 'missing' | 'conflict'> {
  return sql.begin(async (tx) => {
    const [order] = await tx`
      SELECT o.id, o.status FROM orders o
      JOIN table_sessions s ON (s.id, s.tenant_id, s.branch_id) = (o.table_session_id, o.tenant_id, o.branch_id)
      JOIN dining_tables t ON (t.id, t.tenant_id, t.branch_id) = (s.table_id, s.tenant_id, s.branch_id)
      WHERE o.id = ${input.order_id} AND o.tenant_id = ${tenantId} AND o.branch_id = ${branchId}
        AND (t.pos_installation_id IS NULL OR t.pos_installation_id = ${installationId}::uuid)
      FOR UPDATE OF o
    `;
    if (!order) return 'missing';
    if (['created', 'sent_to_pos'].includes(order.status)) return 'conflict';
    const items = await tx<{ id: string }[]>`SELECT id FROM order_items WHERE order_id = ${order.id} ORDER BY id`;
    const overall = orderStatusOf(input.statuses);
    const fallback: KitchenStatus = overall === 'pos_accepted' ? 'pending' : overall;
    const aligned = items.length === input.statuses.length;
    for (const [index, item] of items.entries()) {
      await tx`UPDATE order_items SET kitchen_status = ${aligned ? input.statuses[index] : fallback} WHERE id = ${item.id}`;
    }
    const status = orderStatusOf(aligned ? input.statuses : items.map(() => fallback));
    if (status !== order.status) {
      await tx`UPDATE orders SET status = ${status} WHERE id = ${order.id}`;
    }
    return 'updated';
  });
}
