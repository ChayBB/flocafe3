import { createHash } from 'node:crypto';
import { getDatabase } from '../../db';
import { getTenantCurrency } from '../refund';
import { CloudOrderError } from './order-acceptance';

export function buildCloudCatalog() {
  const db = getDatabase();
  if (getTenantCurrency(db) !== 'THB') throw new CloudOrderError('catalog_currency_unsupported');
  const rows = db
    .prepare(`
    SELECT p.id AS pos_product_id, v.id AS pos_variant_id, p.name, v.name AS variant_name,
      c.name AS category, p.category_id, coalesce(v.price, p.price) AS price
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN product_variants v ON v.product_id = p.id AND v.is_active = 1
    WHERE p.is_active = 1 AND p.deleted_at IS NULL
      AND (p.category_id IS NULL OR (c.is_active = 1 AND c.deleted_at IS NULL))
      AND (coalesce(v.price, p.price) = 0 OR (coalesce(v.price, p.price) > 0 AND p.sale_unit = 'each'))
    ORDER BY p.id, v.id
  `)
    .all() as {
    pos_product_id: string;
    pos_variant_id: string | null;
    name: string;
    variant_name: string | null;
    category: string | null;
    category_id: string | null;
    price: number;
  }[];
  const groupQuery = db.prepare(`
    SELECT id, name, is_required, min_selection, max_selection, allow_multiple_quantities
    FROM addon_groups WHERE is_active = 1 AND id IN (
      SELECT addon_group_id FROM addon_group_product WHERE product_id = ?
      UNION SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?
    ) ORDER BY sort_order, id
  `);
  const optionQuery = db.prepare(`
    SELECT id, name, ROUND(price * 100) AS price_satang FROM addons
    WHERE addon_group_id = ? AND is_active = 1 ORDER BY sort_order, id
  `);
  const items = rows.flatMap((row) => {
    const addonGroups =
      row.price === 0
        ? []
        : (
            groupQuery.all(row.pos_product_id, row.category_id) as {
              id: string;
              name: string;
              is_required: number;
              min_selection: number | null;
              max_selection: number | null;
              allow_multiple_quantities: number;
            }[]
          ).map((group) => ({
            name: group.name,
            min: group.is_required
              ? Math.max(1, group.min_selection || 1)
              : group.min_selection || 0,
            max: group.max_selection,
            multiple: Boolean(group.allow_multiple_quantities),
            options: optionQuery.all(group.id),
          }));
    if (addonGroups.some((group) => group.min > 0 && group.options.length === 0)) return [];
    const groups = addonGroups.filter((group) => group.options.length > 0);
    return [
      {
        external_id: row.pos_variant_id ? `variant:${row.pos_variant_id}` : row.pos_product_id,
        pos_product_id: row.pos_product_id,
        pos_variant_id: row.pos_variant_id,
        name: row.variant_name ? `${row.name} – ${row.variant_name}` : row.name,
        category: row.category,
        price_satang: Math.round(row.price * 100),
        ...(groups.length ? { addon_groups: groups } : {}),
      },
    ];
  });
  if (!items.length) throw new CloudOrderError('catalog_empty');
  const json = JSON.stringify(items);
  if (items.length > 1000 || Buffer.byteLength(json) > 240_000)
    throw new CloudOrderError('catalog_too_large');
  if (
    items.some(
      (item) =>
        !item.name.trim() ||
        item.name.length > 200 ||
        (item.category?.length ?? 0) > 120 ||
        !Number.isSafeInteger(item.price_satang) ||
        item.price_satang < 0 ||
        item.price_satang > 100_000_000,
    )
  ) {
    throw new CloudOrderError('catalog_invalid');
  }
  return { items, fingerprint: createHash('sha256').update(json).digest('hex') };
}
