import type Database from 'better-sqlite3';

import { GUEST_USER_ID } from '../../shared/guest-user';

export { GUEST_USER_ID };

export function tableAwaitingBillPayment(db: Database.Database, tableId: string | number): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM orders WHERE table_id = ? AND type = 'dine_in'
    AND status NOT IN ('completed', 'cancelled')
    AND bill_requested_at IS NOT NULL AND bill_payment_received_at IS NULL LIMIT 1`)
      .get(tableId),
  );
}

/** All the Guest account may do, whatever its role or overrides say: read the menu and order. */
export const GUEST_PERMISSION_IDS: ReadonlySet<string> = new Set([
  'catalog.view',
  'orders.create',
  'printing.execute',
]);

const GUEST_API_ROUTES: [string, RegExp][] = [
  ['GET', /^\/api\/categories\/?$/],
  ['GET', /^\/api\/products\/?$/],
  ['POST', /^\/api\/orders\/?$/],
  ['POST', /^\/api\/orders\/[^/]+\/items\/?$/],
  ['POST', /^\/api\/printers\/print-kot\/?$/],
];

/** The main API routes the Server App calls for a table QR; a Guest token reaches nothing else. */
export function isGuestApiRoute(method: string, requestPath: string): boolean {
  const path = requestPath.toLowerCase();
  return GUEST_API_ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(path));
}

const MAX_LINES = 30;
const MAX_QUANTITY = 50;
// Caps the whole order, so 30 lines of 50 cannot print a kitchen ticket metres long.
const MAX_TOTAL_QUANTITY = 100;
const MAX_ADDON_QUANTITY = 10;
const MAX_ADDONS_PER_LINE = 20;
const MAX_LINE_NOTE = 200;
export const MAX_ORDER_NOTE = 300;

export interface GuestOrderItem {
  product_id: string;
  variant_id: string | null;
  quantity: number;
  addons: { id: string; name: string; price: number; quantity: number }[] | null;
  special_instructions: string | null;
}

export type GuestItemsResult = { ok: true; items: GuestOrderItem[] } | { ok: false; error: string };

function cleanNote(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length > max) return false;
  return trimmed || null;
}

/**
 * Rebuilds a guest's order lines from the database. Only product, variant, quantity,
 * add-on ids and a short note are taken from the request; add-on names and prices always
 * come from the catalog so a guest cannot choose what an item costs.
 */
export function sanitizeGuestOrderItems(db: Database.Database, raw: unknown): GuestItemsResult {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Add at least one item' };
  if (raw.length > MAX_LINES)
    return { ok: false, error: `An order can have at most ${MAX_LINES} lines` };

  const items: GuestOrderItem[] = [];
  let totalQuantity = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'Invalid item' };
    const line = entry as Record<string, unknown>;
    if (typeof line.product_id !== 'string' || !line.product_id) {
      return { ok: false, error: 'Invalid product' };
    }
    const product = db
      .prepare('SELECT id FROM products WHERE id = ? AND is_active = 1 AND deleted_at IS NULL')
      .get(line.product_id);
    if (!product) return { ok: false, error: 'A product is no longer available' };

    const quantity = line.quantity;
    if (
      !Number.isInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > MAX_QUANTITY
    ) {
      return { ok: false, error: `Quantity must be a whole number from 1 to ${MAX_QUANTITY}` };
    }
    totalQuantity += quantity as number;
    if (totalQuantity > MAX_TOTAL_QUANTITY) {
      return { ok: false, error: `An order can have at most ${MAX_TOTAL_QUANTITY} items` };
    }

    let variantId: string | null = null;
    if (line.variant_id !== undefined && line.variant_id !== null) {
      if (typeof line.variant_id !== 'string') return { ok: false, error: 'Invalid variant' };
      const variant = db
        .prepare(
          'SELECT id FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1',
        )
        .get(line.variant_id, line.product_id);
      if (!variant) return { ok: false, error: 'A product option is no longer available' };
      variantId = line.variant_id;
    }

    let addons: GuestOrderItem['addons'] = null;
    if (line.addons !== undefined && line.addons !== null) {
      if (!Array.isArray(line.addons) || line.addons.length > MAX_ADDONS_PER_LINE) {
        return { ok: false, error: 'Invalid add-ons' };
      }
      const resolved: NonNullable<GuestOrderItem['addons']> = [];
      for (const addonEntry of line.addons) {
        const addonInput = addonEntry as Record<string, unknown> | null;
        if (!addonInput || typeof addonInput.id !== 'string')
          return { ok: false, error: 'Invalid add-on' };
        const addonQuantity = addonInput.quantity === undefined ? 1 : addonInput.quantity;
        if (
          typeof addonQuantity !== 'number' ||
          !Number.isInteger(addonQuantity) ||
          addonQuantity <= 0 ||
          addonQuantity > MAX_ADDON_QUANTITY
        ) {
          return { ok: false, error: 'Invalid add-on quantity' };
        }
        const addon = db
          .prepare('SELECT id, name, price FROM addons WHERE id = ? AND is_active = 1')
          .get(addonInput.id) as { id: string; name: string; price: number } | undefined;
        if (!addon) return { ok: false, error: 'An add-on is no longer available' };
        resolved.push({
          id: addon.id,
          name: addon.name,
          price: Number(addon.price) || 0,
          quantity: addonQuantity,
        });
      }
      addons = resolved.length > 0 ? resolved : null;
    }

    const note = cleanNote(line.special_instructions, MAX_LINE_NOTE);
    if (note === false) return { ok: false, error: 'The item note is too long' };

    items.push({
      product_id: line.product_id,
      variant_id: variantId,
      quantity: quantity as number,
      addons,
      special_instructions: note,
    });
  }
  return { ok: true, items };
}

export function sanitizeGuestOrderNote(value: unknown): string | null | false {
  return cleanNote(value, MAX_ORDER_NOTE);
}

const PRODUCT_PRIVATE_KEYS = [
  'cost',
  'low_stock_threshold',
  'inventory_product_id',
  'inventory_deduction_quantity',
  'deleted_at',
];
const VARIANT_PRIVATE_KEYS = [
  'cost_price',
  'low_stock_threshold',
  'inventory_product_id',
  'inventory_deduction_quantity',
  'recipe_multiplier',
];

function without(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Strips cost and inventory-linking fields from catalog rows shown to guests. */
export function sanitizeGuestProduct(product: Record<string, unknown>): Record<string, unknown> {
  const clean = without(product, PRODUCT_PRIVATE_KEYS);
  if (Array.isArray(clean.variants)) {
    clean.variants = (clean.variants as Record<string, unknown>[]).map((variant) =>
      without(variant, VARIANT_PRIVATE_KEYS),
    );
  }
  return clean;
}

export interface GuestTableOrder {
  order_number: string;
  customer_name: string | null;
  /** Set once the table has asked for its bill and payment has not been taken yet. */
  bill_requested_at: string | null;
  items: {
    id: number;
    product_id: string;
    product_name: string;
    quantity: number;
    status: string;
    total: number;
    created_at: string | null;
    saved_price?: { entry_id: number; unit_price: number; weight: number | null };
    /** The staff member who added the dish; null for a guest or when it is not known. */
    ordered_by: string | null;
    ordered_by_guest: boolean;
  }[];
  bill: {
    subtotal: number;
    discount_amount: number;
    service_charge: number;
    tax_amount: number;
    tax_included: boolean;
    round_off: number;
    total: number;
  };
}

const MAX_MERGE_DEPTH = 10;
const GUEST_OPEN_ORDER_STATUSES = "('pending', 'preparing', 'ready', 'served')";

/** The open dine-in order a table's guests are eating from, if any. */
export function guestOpenOrderId(db: Database.Database, tableId: string | number): number | null {
  const row = db
    .prepare(
      `SELECT id FROM orders WHERE table_id = ? AND type = 'dine_in'
          AND status IN ${GUEST_OPEN_ORDER_STATUSES} ORDER BY id DESC LIMIT 1`,
    )
    .get(tableId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Who added each item, from the order's audit trail; follows tables merged into this one. */
function itemActors(
  db: Database.Database,
  order: { id: number; user_id: string | null },
): { byItem: Map<number, string>; fallback: string | null } {
  const byItem = new Map<number, string>();
  const auditRows = db.prepare(
    `SELECT action, actor_user_id, details_json FROM order_audit_log
      WHERE order_id = ? AND action IN ('items_added', 'order_merged') ORDER BY id`,
  );
  const sourceOrder = db.prepare('SELECT id, user_id FROM orders WHERE order_number = ?');
  const visited = new Set<number>();
  let merged = false;
  let queue: { id: number; user_id: string | null }[] = [order];
  for (let depth = 0; queue.length && depth < MAX_MERGE_DEPTH; depth++) {
    const next: typeof queue = [];
    for (const current of queue) {
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const rows = auditRows.all(current.id) as {
        action: string;
        actor_user_id: string;
        details_json: string | null;
      }[];
      for (const row of rows) {
        let details: Record<string, unknown> = {};
        try {
          details = row.details_json ? JSON.parse(row.details_json) : {};
        } catch {
          continue;
        }
        if (row.action === 'items_added' && Array.isArray(details.item_ids)) {
          for (const itemId of details.item_ids) {
            if (!byItem.has(Number(itemId))) byItem.set(Number(itemId), row.actor_user_id);
          }
        } else if (row.action === 'order_merged') {
          const source =
            typeof details.from_order === 'string'
              ? (sourceOrder.get(details.from_order) as typeof order | undefined)
              : undefined;
          if (source && source.id !== current.id) {
            merged = true;
            next.push(source);
          }
        }
      }
    }
    queue = next;
  }
  // Without a merge, every item the audit trail does not name came with the order itself.
  return { byItem, fallback: merged ? null : order.user_id };
}

/** The table's open dine-in order as its guests may see it: dishes, kitchen status and bill. */
export function guestTableOrder(
  db: Database.Database,
  tableId: string | number,
): GuestTableOrder | null {
  const order = db
    .prepare(
      `SELECT o.id, o.order_number, o.user_id, c.name AS customer_name,
              CASE WHEN o.bill_payment_received_at IS NULL THEN o.bill_requested_at END
                AS bill_requested_at,
              o.subtotal, o.discount_amount, o.service_charge, o.tax_amount, o.round_off, o.total
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.table_id = ? AND o.type = 'dine_in'
          AND o.status IN ${GUEST_OPEN_ORDER_STATUSES}
        ORDER BY o.id DESC LIMIT 1`,
    )
    .get(tableId) as
    | {
        id: number;
        order_number: string;
        user_id: string | null;
        customer_name: string | null;
        bill_requested_at: string | null;
        subtotal: number | null;
        discount_amount: number | null;
        service_charge: number | null;
        tax_amount: number | null;
        round_off: number | null;
        total: number | null;
      }
    | undefined;
  if (!order) return null;
  const rows = db
    .prepare(
      `SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.status, oi.total,
              oi.created_at, oi.tax_type, oi.unit_price, oi.weight,
              CASE WHEN oi.weight_pending = 0 AND oi.status <> 'cancelled' THEN (
                SELECT id FROM order_audit_log
                WHERE order_id = oi.order_id AND order_item_id = oi.id
                  AND action IN ('item_weighed', 'item_kitchen_priced')
                ORDER BY id DESC LIMIT 1
              ) END AS price_entry_id
         FROM order_items oi
        WHERE oi.order_id = ? AND oi.status NOT IN ('voided', 'void_adjustment', 'refunded')
        ORDER BY oi.id`,
    )
    .all(order.id) as (Omit<GuestTableOrder['items'][number], 'ordered_by' | 'ordered_by_guest'> & {
    tax_type: string | null;
    unit_price: number;
    weight: number | null;
    price_entry_id: number | null;
  })[];
  const actors = itemActors(db, order);
  const actorIds = [...new Set([...actors.byItem.values(), actors.fallback])].filter(
    (id): id is string => Boolean(id) && id !== GUEST_USER_ID,
  );
  const names = new Map<string, string>(
    actorIds.length
      ? (
          db
            .prepare(
              `SELECT id, name FROM users WHERE id IN (${actorIds.map(() => '?').join(',')})`,
            )
            .all(...actorIds) as { id: string; name: string }[]
        ).map((user) => [user.id, user.name])
      : [],
  );
  const items = rows.map(({ tax_type: _taxType, unit_price, weight, price_entry_id, ...item }) => {
    const actor = actors.byItem.get(item.id) ?? actors.fallback;
    return {
      ...item,
      ...(price_entry_id !== null && {
        saved_price: { entry_id: price_entry_id, unit_price, weight },
      }),
      ordered_by: actor && actor !== GUEST_USER_ID ? (names.get(actor) ?? null) : null,
      ordered_by_guest: actor === GUEST_USER_ID,
    };
  });
  const billed = rows.filter((item) => item.status !== 'cancelled');
  return {
    order_number: order.order_number,
    customer_name: order.customer_name,
    bill_requested_at: order.bill_requested_at,
    items,
    bill: {
      subtotal: Number(order.subtotal) || 0,
      discount_amount: Number(order.discount_amount) || 0,
      service_charge: Number(order.service_charge) || 0,
      tax_amount: Number(order.tax_amount) || 0,
      tax_included: billed.length > 0 && billed.every((item) => item.tax_type === 'inclusive'),
      round_off: Number(order.round_off) || 0,
      total: Number(order.total) || 0,
    },
  };
}
