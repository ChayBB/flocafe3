import type Database from 'better-sqlite3';

export const GUEST_USER_ID = 'guest-self-order';

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
  items: {
    id: number;
    product_name: string;
    quantity: number;
    status: string;
    total: number;
    created_at: string | null;
  }[];
}

/** The table's open dine-in order as its guests may see it: dish names, counts, kitchen status. */
export function guestTableOrder(
  db: Database.Database,
  tableId: string | number,
): GuestTableOrder | null {
  const order = db
    .prepare(
      `SELECT o.id, o.order_number, c.name AS customer_name
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.table_id = ? AND o.type = 'dine_in'
          AND o.status IN ('pending', 'preparing', 'ready')
        ORDER BY o.id DESC LIMIT 1`,
    )
    .get(tableId) as { id: number; order_number: string; customer_name: string | null } | undefined;
  if (!order) return null;
  const items = db
    .prepare(
      `SELECT id, product_name, quantity, status, total, created_at
         FROM order_items
        WHERE order_id = ? AND status NOT IN ('voided', 'void_adjustment', 'refunded')
        ORDER BY id`,
    )
    .all(order.id) as GuestTableOrder['items'];
  return { order_number: order.order_number, customer_name: order.customer_name, items };
}
