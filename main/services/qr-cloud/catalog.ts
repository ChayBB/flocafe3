import { createHash } from 'node:crypto';
import { getDatabase } from '../../db';
import { getTenantCurrency } from '../refund';
import { QrCloudClientError } from './client';
import { CloudOrderError } from './order-acceptance';

const MAX_IMAGE_BYTES = 96_000;
const MAX_UPLOAD_JSON_BYTES = 200_000;
const IMAGE_DATA_URL = /^data:image\/(webp|png|jpeg|jpg|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  webp: (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** Content-addressed name and bytes of a product photo, or null when it cannot be published. */
export function catalogImageOf(imageUrl: string | null | undefined) {
  const match = IMAGE_DATA_URL.exec(imageUrl ?? '');
  if (!match) return null;
  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !SIGNATURES[ext](bytes)) return null;
  return { name: `${createHash('sha256').update(bytes).digest('hex')}.${ext}`, bytes };
}

export function buildCloudCatalog() {
  const db = getDatabase();
  if (getTenantCurrency(db) !== 'THB') throw new CloudOrderError('catalog_currency_unsupported');
  const rows = db
    .prepare(`
    SELECT p.id AS pos_product_id, v.id AS pos_variant_id, p.name, v.name AS variant_name,
      c.name AS category, p.category_id, coalesce(v.price, p.price) AS price, p.image_url
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
    image_url: string | null;
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
  const images = new Map<string, Buffer>();
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
    const image = catalogImageOf(row.image_url);
    if (image) images.set(image.name, image.bytes);
    return [
      {
        external_id: row.pos_variant_id ? `variant:${row.pos_variant_id}` : row.pos_product_id,
        pos_product_id: row.pos_product_id,
        pos_variant_id: row.pos_variant_id,
        name: row.variant_name ? `${row.name} – ${row.variant_name}` : row.name,
        category: row.category,
        price_satang: Math.round(row.price * 100),
        ...(groups.length ? { addon_groups: groups } : {}),
        ...(image ? { image: image.name } : {}),
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
  return { items, images, fingerprint: createHash('sha256').update(json).digest('hex') };
}

export interface CatalogImageRequest {
  names: string[];
  images?: { name: string; data: string }[];
}

function missingOf(response: unknown, names: string[]) {
  const missing = (response as { missing?: unknown } | null)?.missing;
  if (
    !Array.isArray(missing) ||
    missing.some((name) => typeof name !== 'string' || !names.includes(name))
  )
    throw new QrCloudClientError('bad_response', 'invalid_menu_images');
  return missing as string[];
}

/**
 * Uploads the photos the Cloud does not hold yet, before the catalog that names them.
 * Returns false when the Cloud predates menu photos, so the catalog goes out without them.
 */
export async function uploadCatalogImages(
  send: (body: CatalogImageRequest) => Promise<unknown>,
  images: Map<string, Buffer>,
): Promise<boolean> {
  const names = [...images.keys()];
  if (!names.length) return true;
  let missing: string[];
  try {
    missing = missingOf(await send({ names }), names);
  } catch (error) {
    if (error instanceof QrCloudClientError && error.detail === 'HTTP 404') return false;
    throw error;
  }
  let batch: { name: string; data: string }[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const sent = batch.map((image) => image.name);
    if (missingOf(await send({ names: sent, images: batch }), sent).length)
      throw new QrCloudClientError('bad_response', 'menu_image_rejected');
    batch = [];
    size = 0;
  };
  for (const name of new Set(missing)) {
    const data = images.get(name)!.toString('base64');
    if (size + data.length + 100 > MAX_UPLOAD_JSON_BYTES) await flush();
    batch.push({ name, data });
    size += data.length + 100;
  }
  await flush();
  return true;
}
