import { getDatabase, now, recordAuthAudit } from '../../db';
import { readConnectorSetting, type QrCloudConfig } from './config';
import {
  CONNECTOR_EVENT_ID,
  fetchOwnerMenuChanges,
  QrCloudClientError,
  reportOwnerMenuChange,
} from './client';
import { catalogImageOf } from './catalog';
import { readApprovedCa } from './tls';

const CHECK_INTERVAL_MS = 60_000;
const UNSUPPORTED_RETRY_MS = 10 * 60_000;
const IMAGE_NAME = /^[a-f0-9]{64}\.(webp|png|jpeg)$/;

export interface OwnerMenuChange {
  id: string;
  pos_product_id: string;
  pos_variant_id: string | null;
  field: 'price' | 'image';
  base_value: string | null;
  new_value: string;
  force: boolean;
  image_data?: string | null;
}

type Outcome = { outcome: 'applied' | 'conflict' | 'failed'; pos_value?: string | null; detail?: string };

let nextCheckAt = 0;

export function __resetOwnerMenuScheduleForTests(): void {
  nextCheckAt = 0;
}

function audit(change: OwnerMenuChange, from: string | null, to: string) {
  recordAuthAudit(getDatabase(), {
    userId: null,
    eventType: 'qr_cloud_owner_menu_change',
    outcome: 'success',
    details: {
      change_id: change.id,
      field: change.field,
      product_id: change.pos_product_id,
      variant_id: change.pos_variant_id,
      from,
      to,
    },
  });
}

/**
 * Applies one owner change from the Cloud portal. The POS stays authoritative: a value staff changed
 * since the owner saw it is reported as a conflict unless the owner chose to override it.
 */
export function applyOwnerMenuChange(change: OwnerMenuChange): Outcome {
  const db = getDatabase();
  const product = db
    .prepare(
      'SELECT id, price, image_url FROM products WHERE id = ? AND is_active = 1 AND deleted_at IS NULL',
    )
    .get(change.pos_product_id) as { id: string; price: number; image_url: string | null } | undefined;
  if (!product) return { outcome: 'failed', detail: 'product_missing' };

  if (change.field === 'price') {
    const target = Number(change.new_value);
    if (!Number.isSafeInteger(target) || target < 0 || target > 100_000_000)
      return { outcome: 'failed', detail: 'price_invalid' };
    const variant = change.pos_variant_id
      ? (db
          .prepare(
            'SELECT id, price FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1',
          )
          .get(change.pos_variant_id, product.id) as { id: string; price: number | null } | undefined)
      : undefined;
    if (change.pos_variant_id && !variant) return { outcome: 'failed', detail: 'variant_missing' };
    const current = Math.round((variant?.price ?? product.price) * 100);
    if (current === target) return { outcome: 'applied' };
    if (!change.force && String(current) !== change.base_value)
      return { outcome: 'conflict', pos_value: String(current) };
    db.transaction(() => {
      if (variant)
        db.prepare('UPDATE product_variants SET price = ?, updated_at = ? WHERE id = ?').run(
          target / 100,
          now(),
          variant.id,
        );
      else
        db.prepare('UPDATE products SET price = ?, updated_at = ? WHERE id = ?').run(
          target / 100,
          now(),
          product.id,
        );
      audit(change, String(current), String(target));
    })();
    return { outcome: 'applied' };
  }

  const name = IMAGE_NAME.exec(change.new_value);
  const data = change.image_data ?? '';
  if (!name || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { outcome: 'failed', detail: 'image_invalid' };
  const dataUrl = `data:image/${name[1]};base64,${data}`;
  const verified = catalogImageOf(dataUrl);
  if (!verified || verified.name !== change.new_value)
    return { outcome: 'failed', detail: 'image_invalid' };
  const current = catalogImageOf(product.image_url)?.name ?? null;
  if (current === change.new_value) return { outcome: 'applied' };
  if (!change.force && current !== change.base_value)
    return { outcome: 'conflict', pos_value: current };
  db.transaction(() => {
    db.prepare('UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?').run(
      dataUrl,
      now(),
      product.id,
    );
    audit(change, current, change.new_value);
  })();
  return { outcome: 'applied' };
}

function parseChanges(response: unknown): OwnerMenuChange[] {
  const list = (response as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(list)) throw new QrCloudClientError('bad_response', 'invalid_menu_changes');
  return list.filter(
    (entry): entry is OwnerMenuChange =>
      !!entry &&
      typeof entry === 'object' &&
      CONNECTOR_EVENT_ID.test(entry.id) &&
      typeof entry.pos_product_id === 'string' &&
      (entry.pos_variant_id === null || typeof entry.pos_variant_id === 'string') &&
      (entry.field === 'price' || entry.field === 'image') &&
      (entry.base_value === null || typeof entry.base_value === 'string') &&
      typeof entry.new_value === 'string' &&
      typeof entry.force === 'boolean',
  );
}

/** Pulls pending owner changes at most once a minute; an older Cloud without the route is retried rarely. */
export async function syncOwnerMenuChanges(config: QrCloudConfig, signal: AbortSignal) {
  if (Date.now() < nextCheckAt) return;
  nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
  const options = { config, token: readConnectorSetting(), caPem: readApprovedCa()?.pem, signal };
  let changes: OwnerMenuChange[];
  try {
    changes = parseChanges(await fetchOwnerMenuChanges(options));
  } catch (error) {
    if (error instanceof QrCloudClientError && error.detail === 'HTTP 404')
      nextCheckAt = Date.now() + UNSUPPORTED_RETRY_MS;
    return;
  }
  for (const change of changes) {
    if (signal.aborted) return;
    let result: Outcome;
    try {
      result = applyOwnerMenuChange(change);
    } catch {
      result = { outcome: 'failed', detail: 'apply_error' };
    }
    await reportOwnerMenuChange(options, change.id, result).catch(() => undefined);
  }
}
