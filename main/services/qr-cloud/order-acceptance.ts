import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../db';
import { sanitizeGuestOrderItems } from '../../lib/guest-order';
import { placeGuestOrder } from '../../lib/guest-order-placement';
import { getHttpRequestSignal } from '../../shutdown';
import { CONNECTOR_EVENT_ID, fetchConnectorOrder } from './client';
import { readConfig, readConnectorSetting } from './config';
import { openInbox } from './inbox';
import { readApprovedCa } from './tls';

export class CloudOrderError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}

export function pendingCloudOrders() {
  return openInbox()
    .prepare(`
    SELECT event_id, cloud_created_at, last_error FROM inbox_events
    WHERE kind = 'order.created' AND status = 'received'
    ORDER BY received_at, event_id LIMIT 30
  `)
    .all();
}

function localEvent(eventId: string) {
  if (!CONNECTOR_EVENT_ID.test(eventId)) throw new CloudOrderError('event_not_found', 404);
  const event = openInbox()
    .prepare(`
    SELECT payload_json, status FROM inbox_events WHERE event_id = ? AND kind = 'order.created'
  `)
    .get(eventId) as { payload_json: string; status: string } | undefined;
  if (!event) throw new CloudOrderError('event_not_found', 404);
  return event;
}

function readCloudAddons(raw: unknown) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new CloudOrderError('invalid_cloud_order', 502);
  return raw.map(
    (
      addon: { id?: unknown; name?: unknown; quantity?: unknown; price_satang?: unknown } | null,
    ) => {
      if (
        !addon ||
        typeof addon.id !== 'string' ||
        !addon.id ||
        typeof addon.name !== 'string' ||
        typeof addon.quantity !== 'number' ||
        !Number.isInteger(addon.quantity) ||
        addon.quantity < 1 ||
        addon.quantity > 10 ||
        typeof addon.price_satang !== 'number' ||
        !Number.isSafeInteger(addon.price_satang) ||
        addon.price_satang < 0
      ) {
        throw new CloudOrderError('invalid_cloud_order', 502);
      }
      return {
        id: addon.id,
        name: addon.name,
        quantity: addon.quantity,
        price_satang: addon.price_satang,
      };
    },
  );
}

function resolveCloudOrder(raw: unknown, expectedId: unknown, db: ReturnType<typeof getDatabase>) {
  if (!raw || typeof raw !== 'object') throw new CloudOrderError('invalid_cloud_order', 502);
  const order = raw as Record<string, unknown>;
  if (
    typeof order.order_id !== 'string' ||
    !CONNECTOR_EVENT_ID.test(order.order_id) ||
    order.order_id !== expectedId ||
    typeof order.table_name !== 'string' ||
    typeof order.created_at !== 'string' ||
    !Number.isFinite(Date.parse(order.created_at)) ||
    typeof order.total_satang !== 'number' ||
    !Number.isSafeInteger(order.total_satang) ||
    order.total_satang < 0 ||
    !Array.isArray(order.items) ||
    !order.items.length ||
    order.items.length > 30
  ) {
    throw new CloudOrderError('invalid_cloud_order', 502);
  }
  if (
    order.note != null &&
    (typeof order.note !== 'string' || Array.from(order.note).length > 200)
  ) {
    throw new CloudOrderError('invalid_cloud_order', 502);
  }
  if (
    order.pos_table_id != null &&
    (typeof order.pos_table_id !== 'string' ||
      !order.pos_table_id ||
      order.pos_table_id.length > 128)
  ) {
    throw new CloudOrderError('invalid_cloud_order', 502);
  }

  const productQuery = db.prepare(`
    SELECT p.id, p.name, coalesce(v.price, p.price) AS price FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id AND v.id = ? AND v.is_active = 1
    WHERE p.id = ? AND p.is_active = 1 AND p.deleted_at IS NULL AND p.sale_unit = 'each'
      AND (v.id IS NOT NULL OR (? IS NULL AND NOT EXISTS (
        SELECT 1 FROM product_variants active WHERE active.product_id = p.id AND active.is_active = 1
      )))
  `);
  const lines = order.items.map((item: unknown) => {
    const line = item as Record<string, unknown> | null;
    if (
      !line ||
      typeof line.external_id !== 'string' ||
      !line.external_id ||
      typeof line.name !== 'string' ||
      typeof line.quantity !== 'number' ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 99 ||
      typeof line.unit_price_satang !== 'number' ||
      !Number.isSafeInteger(line.unit_price_satang) ||
      line.unit_price_satang < 0 ||
      typeof line.note !== 'string' ||
      line.note.length > 160
    ) {
      throw new CloudOrderError('invalid_cloud_order', 502);
    }
    if (
      line.pos_variant_id != null &&
      (typeof line.pos_variant_id !== 'string' || !line.pos_variant_id)
    ) {
      throw new CloudOrderError('invalid_cloud_order', 502);
    }
    const variantId = line.pos_variant_id ?? null;
    const addons = readCloudAddons(line.addons);
    const product = productQuery.get(variantId, line.external_id, variantId) as
      | { id: string; name: string; price: number }
      | undefined;
    return {
      cloud_name: line.name,
      quantity: line.quantity,
      note: line.note,
      unit_price_satang: line.unit_price_satang,
      addons,
      addon_price_satang: addons.reduce(
        (sum, addon) => sum + addon.price_satang * addon.quantity,
        0,
      ),
      product: product ?? null,
      variant_id: variantId,
    };
  });
  if (
    lines.reduce(
      (sum, line) => sum + line.quantity * (line.unit_price_satang + line.addon_price_satang),
      0,
    ) !== order.total_satang
  ) {
    throw new CloudOrderError('invalid_cloud_order', 502);
  }
  const mapped = sanitizeGuestOrderItems(
    db,
    lines.map((line) => ({
      product_id: line.product?.id,
      variant_id: line.variant_id,
      quantity: line.quantity,
      addons: line.addons,
      special_instructions: line.note,
    })),
  );
  return {
    preview: {
      order_id: order.order_id,
      table_name: order.table_name,
      pos_table_id: order.pos_table_id ?? null,
      table_session_current:
        typeof order.table_session_current === 'boolean' ? order.table_session_current : null,
      created_at: order.created_at,
      total_satang: order.total_satang,
      note: typeof order.note === 'string' && order.note.trim() ? order.note.trim() : null,
      lines,
      validation: lines.some((line) => !line.product)
        ? 'missing_product_mapping'
        : mapped.ok
          ? null
          : 'unsupported_items',
    },
    items: mapped.ok ? mapped.items : null,
  };
}

async function readPendingOrder(
  req: Request | undefined,
  eventId: string,
  backgroundSignal?: AbortSignal,
) {
  const event = localEvent(eventId);
  if (event.status !== 'received') throw new CloudOrderError('event_not_pending');
  const config = readConfig();
  if (!config.enabled || config.mode !== 'integrated' || config.cutoverPending) {
    throw new CloudOrderError('connector_inactive');
  }
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const signal = backgroundSignal ?? (req && getHttpRequestSignal(req));
  const token = readConnectorSetting();
  const raw = await fetchConnectorOrder(
    {
      config,
      token,
      caPem: readApprovedCa()?.pem,
      signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    },
    eventId,
  );
  const current = readConfig();
  if (
    !current.enabled ||
    current.mode !== 'integrated' ||
    current.cutoverPending ||
    current.cloudUrl !== config.cloudUrl ||
    readConnectorSetting() !== token
  ) {
    throw new CloudOrderError('connector_changed');
  }
  const payload = JSON.parse(event.payload_json) as { order_id?: unknown } | null;
  return { ...resolveCloudOrder(raw, payload?.order_id, getDatabase()), cloudUrl: config.cloudUrl };
}

export async function previewCloudOrder(req: Request, eventId: string) {
  const { preview } = await readPendingOrder(req, eventId);
  const db = getDatabase();
  const tables = preview.pos_table_id
    ? db
        .prepare('SELECT id, number FROM tables WHERE is_active = 1 AND id = ?')
        .all(preview.pos_table_id)
    : db.prepare('SELECT id, number FROM tables WHERE is_active = 1 ORDER BY number, id').all();
  return { ...preview, tables };
}

export async function acceptCloudOrder(
  req: Request | undefined,
  eventId: string,
  actorId: string,
  tableId: unknown,
  automatic?: { since: string; cloudUrl: string; signal: AbortSignal },
) {
  localEvent(eventId);
  const inbox = openInbox();
  const receipt = () =>
    inbox
      .prepare(`
    SELECT pos_order_number FROM order_acceptances WHERE event_id = ?
  `)
      .get(eventId) as { pos_order_number: string } | undefined;
  const previous = receipt();
  if (previous) return previous;
  const { preview, items, cloudUrl } = await readPendingOrder(req, eventId, automatic?.signal);
  if (automatic) {
    if (
      automatic.signal.aborted ||
      readConfig().automaticSince !== automatic.since ||
      cloudUrl !== automatic.cloudUrl
    ) {
      throw new CloudOrderError('automatic_mode_changed');
    }
    tableId = preview.pos_table_id;
    if (!preview.table_session_current) throw new CloudOrderError('cloud_table_session_closed');
  }
  if (
    typeof tableId !== 'string' ||
    !tableId ||
    tableId.length > 128 ||
    !getDatabase().prepare('SELECT 1 FROM tables WHERE id = ? AND is_active = 1').get(tableId)
  )
    throw new CloudOrderError('invalid_pos_table', 400);

  if (preview.pos_table_id && preview.pos_table_id !== tableId) {
    throw new CloudOrderError('cloud_table_mismatch');
  }
  if (preview.table_session_current === false)
    throw new CloudOrderError('cloud_table_session_closed');
  if (!items) throw new CloudOrderError(preview.validation ?? 'unsupported_items');
  const result = await placeGuestOrder(req, {
    tableId,
    items: automatic
      ? items.map((item, index) => ({
          ...item,
          expected_cloud_price_satang: preview.lines[index].unit_price_satang,
          expected_cloud_addon_satang: preview.lines[index].addon_price_satang,
        }))
      : items,
    note: preview.note,
    key: preview.order_id,
    source: 'cloud',
    signal: automatic && AbortSignal.any([automatic.signal, AbortSignal.timeout(15000)]),
  });
  if (result.kind !== 'placed' || !result.orderNumber) {
    if (
      (result.kind === 'held' && result.body.code === 'bill_awaiting_payment') ||
      (result.kind === 'failed' && result.code === 'bill_awaiting_payment')
    ) {
      throw new CloudOrderError('bill_awaiting_payment');
    }
    if (result.kind === 'failed' && result.error === 'pos_price_changed') {
      throw new CloudOrderError(result.error);
    }
    const transient = result.kind === 'failed' && (result.status >= 500 || result.status === 429);
    throw new CloudOrderError(
      transient ? 'pos_retry_required' : 'pos_order_failed',
      transient ? 503 : 409,
    );
  }

  return inbox.transaction(() => {
    inbox
      .prepare(`INSERT INTO order_acceptances (event_id, actor_id, pos_order_number)
      VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .run(eventId, actorId, result.orderNumber);
    inbox
      .prepare(`INSERT INTO order_ack_jobs (event_id, cloud_url, cloud_order_id, pos_receipt_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .run(eventId, cloudUrl, preview.order_id, randomUUID());
    if (result.itemIds.length) {
      inbox
        .prepare(`INSERT INTO order_status_sync (event_id, cloud_url, cloud_order_id, pos_item_ids)
        VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
        .run(eventId, cloudUrl, preview.order_id, JSON.stringify(result.itemIds));
    }
    inbox.prepare('DELETE FROM order_auto_jobs WHERE event_id = ?').run(eventId);
    inbox
      .prepare(
        "UPDATE inbox_events SET status = 'applied', last_error = NULL, updated_at = datetime('now') WHERE event_id = ?",
      )
      .run(eventId);
    return receipt()!;
  })();
}
