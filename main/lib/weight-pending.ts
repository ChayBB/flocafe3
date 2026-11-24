import type { Request, Response, NextFunction } from 'express';
import { getDatabase } from '../db';
import { TERMINAL_ITEM_STATUSES } from '../../shared/order-item-status';

type Db = ReturnType<typeof getDatabase>;

export const WEIGHT_PRICED_GROUP_NAME = 'ราคาตามน้ำหนัก';
export const WEIGHT_PENDING_NOTE = 'รอระบุน้ำหนัก';
export const WEIGHT_PENDING_ERROR = 'Enter the weight of every weight-priced item first';
export const KITCHEN_PRICE_NOTE = 'เมนูพิเศษครัวระบุราคา';

/** How a line that is priced after the order gets its price. */
export type PendingPriceMode = 'weight' | 'kitchen_price';

/**
 * A product is priced after the order when one of its add-on groups is the weight-priced group
 * or is flagged "awaiting price"; both use the same weighing flow.
 */
export function isWeightPricedProduct(
  db: Db,
  product: { id: string; category_id?: string | null },
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM addon_groups g
       WHERE (TRIM(g.name) = ? OR g.price_pending = 1)
         AND (g.id IN (SELECT addon_group_id FROM addon_group_product WHERE product_id = ?)
           OR g.id IN (SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?))
       LIMIT 1`,
    )
    .get(WEIGHT_PRICED_GROUP_NAME, product.id, product.category_id ?? null);
  return Boolean(row);
}

/**
 * A product linked to a "kitchen sets the price" group waits for the kitchen's set price;
 * otherwise a weight-priced or "awaiting price" group makes it wait for a weight.
 */
export function pendingPriceModeForProduct(
  db: Db,
  product: { id: string; category_id?: string | null },
): PendingPriceMode | null {
  const kitchen = db
    .prepare(
      `SELECT 1 FROM addon_groups g
       WHERE g.kitchen_price = 1
         AND (g.id IN (SELECT addon_group_id FROM addon_group_product WHERE product_id = ?)
           OR g.id IN (SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?))
       LIMIT 1`,
    )
    .get(product.id, product.category_id ?? null);
  if (kitchen) return 'kitchen_price';
  return isWeightPricedProduct(db, product) ? 'weight' : null;
}

/** The note a pending line carries for the kitchen, by how its price is set. */
export function withPendingPriceNote(
  note: string | null | undefined,
  mode: PendingPriceMode,
): string {
  if (mode === 'weight') return withWeightPendingNote(note);
  const current = (note ?? '').trim();
  if (current.includes(KITCHEN_PRICE_NOTE)) return current;
  return current ? `${KITCHEN_PRICE_NOTE} | ${current}` : KITCHEN_PRICE_NOTE;
}

/** Removes the automatic pending-price markers before a note is validated as user text. */
export function stripPendingPriceNotes(note: string | null | undefined): string | undefined {
  return note
    ?.replace(`${WEIGHT_PENDING_NOTE} | `, '')
    .replace(WEIGHT_PENDING_NOTE, '')
    .replace(`${KITCHEN_PRICE_NOTE} | `, '')
    .replace(KITCHEN_PRICE_NOTE, '');
}

/** Prepends the kitchen marker to a line's note unless it is already there. */
export function withWeightPendingNote(note: string | null | undefined): string {
  const current = (note ?? '').trim();
  if (current.includes(WEIGHT_PENDING_NOTE)) return current;
  return current ? `${WEIGHT_PENDING_NOTE} | ${current}` : WEIGHT_PENDING_NOTE;
}

/** Drops the waiting markers once the kitchen has priced the line; the KDS shows the price instead. */
export function withoutPendingPriceNotes(note: string | null | undefined): string | null {
  return stripPendingPriceNotes(note)?.trim() || null;
}

export function tablePriceItems(db: Db, tableId: string) {
  return db
    .prepare(
      `SELECT item.id, item.product_name, item.pending_price_mode,
              item.weight, item.unit_price, entry.id AS price_entry_id
       FROM order_items item
       LEFT JOIN order_audit_log entry ON item.weight_pending = 0 AND entry.id = (
         SELECT id FROM order_audit_log
         WHERE order_id = item.order_id AND order_item_id = item.id
           AND action IN ('item_weighed', 'item_kitchen_priced')
         ORDER BY id DESC LIMIT 1
       )
       WHERE item.order_id IN (
         SELECT id FROM orders WHERE table_id = ? AND status NOT IN ('completed', 'cancelled')
       )
         AND (item.weight_pending = 1 OR entry.id IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM order_audit_log approval
           WHERE approval.order_id = item.order_id AND approval.order_item_id = item.id
             AND approval.action = 'item_kitchen_price_approved' AND approval.id > entry.id
         )
         AND item.status NOT IN (${TERMINAL_ITEM_STATUSES.map(() => '?').join(',')})
       ORDER BY item.id`,
    )
    .all(tableId, ...TERMINAL_ITEM_STATUSES) as {
    id: number;
    product_name: string;
    pending_price_mode: PendingPriceMode | null;
    weight: number | null;
    unit_price: number;
    price_entry_id: number | null;
  }[];
}

export function orderHasWeightPending(db: Db, orderId: unknown): boolean {
  if (orderId == null) return false;
  const placeholders = TERMINAL_ITEM_STATUSES.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT 1 FROM order_items
       WHERE order_id = ? AND weight_pending = 1 AND status NOT IN (${placeholders})
       LIMIT 1`,
    )
    .get(orderId, ...TERMINAL_ITEM_STATUSES);
  return Boolean(row);
}

export function billHasWeightPending(db: Db, billId: unknown): boolean {
  if (billId == null) return false;
  const bill = db.prepare('SELECT order_id FROM bills WHERE id = ?').get(billId) as
    | { order_id: number | string }
    | undefined;
  return bill ? orderHasWeightPending(db, bill.order_id) : false;
}

export function sendWeightPendingError(res: Response): Response {
  return res.status(409).json({ error: WEIGHT_PENDING_ERROR, code: 'weight_pending' });
}

/** Route guard for `/:id` bill routes that take payment or produce a receipt. */
export function rejectBillWhileWeightPending(req: Request, res: Response, next: NextFunction) {
  if (billHasWeightPending(getDatabase(), req.params.id)) return sendWeightPendingError(res);
  return next();
}
