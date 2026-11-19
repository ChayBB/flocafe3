import { getDatabase, now, recordOrderAudit } from '../db';

/** Kitchen stages in which a dish can still be flagged as out of stock instead of cooked. */
const OUT_OF_STOCK_STAGES = ['pending', 'preparing'];

/**
 * Flags or clears a dish the kitchen cannot make. The flag asks the table's service staff to cancel
 * it with the guest; cancelling the item ends the request. Throws a 409 error once cooking is past.
 */
export function setKdsItemOutOfStock(
  db: ReturnType<typeof getDatabase>,
  item: { id: number | string; order_id: number | string; status: string; product_name?: string },
  actorUserId: string,
  outOfStock: boolean,
): void {
  if (outOfStock && !OUT_OF_STOCK_STAGES.includes(item.status)) {
    throw Object.assign(new Error('Only waiting or cooking items can be marked out of stock'), {
      statusCode: 409,
    });
  }
  const actorName =
    (
      db.prepare('SELECT name FROM users WHERE id = ?').get(actorUserId) as
        | { name: string }
        | undefined
    )?.name ?? null;
  const changed = outOfStock
    ? db
        .prepare(
          `UPDATE order_items SET out_of_stock_at = ?, out_of_stock_by_name = ?, updated_at = ?
           WHERE id = ? AND out_of_stock_at IS NULL`,
        )
        .run(now(), actorName, now(), item.id).changes
    : db
        .prepare(
          `UPDATE order_items SET out_of_stock_at = NULL, out_of_stock_by_name = NULL, updated_at = ?
           WHERE id = ? AND out_of_stock_at IS NOT NULL`,
        )
        .run(now(), item.id).changes;
  if (changed === 0) return;
  recordOrderAudit(db, {
    orderId: item.order_id,
    orderItemId: item.id,
    actorUserId,
    action: outOfStock ? 'item_out_of_stock' : 'item_out_of_stock_cleared',
    details: { product_name: item.product_name ?? null, status: item.status },
  });
}

/** The optional `out_of_stock` flag of a KDS item update; undefined when the request changes the stage. */
export function readOutOfStockFlag(body: unknown): boolean | undefined {
  const value = (body as { out_of_stock?: unknown } | undefined)?.out_of_stock;
  return typeof value === 'boolean' ? value : undefined;
}

export const OUT_OF_STOCK_LOCKED_ERROR =
  'This item is out of stock; it can only be cancelled with the guest';

/** An out-of-stock dish stays where it is until the guest's cancellation removes it. */
export function outOfStockStageLock(item: { out_of_stock_at?: string | null }): string | null {
  return item.out_of_stock_at ? OUT_OF_STOCK_LOCKED_ERROR : null;
}

export function assertNoOutOfStockStageLock(item: { out_of_stock_at?: string | null }): void {
  const locked = outOfStockStageLock(item);
  if (locked) throw Object.assign(new Error(locked), { statusCode: 409 });
}
