import { createHash } from 'node:crypto';
import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';
import type { ConnectorIdentity } from './connector-auth';
import { inTenant } from './tenant-scope';

/** The POS refuses larger photos, so owner uploads share its limit. */
export const OWNER_IMAGE_MAX_BYTES = 96_000;
export const MAX_PRICE_SATANG = 100_000_000;
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** A content-addressed name for an owner photo, or null when the bytes are not an accepted image. */
export function ownerImage(data: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > OWNER_IMAGE_MAX_BYTES) return null;
  const ext = Object.keys(SIGNATURES).find((type) => SIGNATURES[type](bytes));
  if (!ext) return null;
  return { name: `${createHash('sha256').update(bytes).digest('hex')}.${ext}`, bytes };
}

type Change = { field: 'price' | 'image'; value: string };

/**
 * Records an owner's change against the value the POS last published. An earlier pending change to
 * the same item and field is superseded.
 */
export async function requestMenuChange(
  sql: Sql,
  scope: { tenantId: string; branchId: string; userId: string },
  menuItemId: string,
  change: Change,
  image?: { name: string; bytes: Buffer },
) {
  return sql.begin(async (tx) => {
    const [item] = await tx`
      SELECT id, pos_product_id, pos_variant_id, price_satang, image FROM menu_items
      WHERE id = ${menuItemId} AND tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId}
        AND available AND pos_product_id IS NOT NULL
      FOR UPDATE`;
    if (!item) return null;
    if (image) {
      await tx`INSERT INTO menu_images (tenant_id, name, bytes) VALUES (${scope.tenantId}, ${image.name}, ${image.bytes})
        ON CONFLICT (tenant_id, name) DO NOTHING`;
    }
    const base = change.field === 'price' ? String(item.price_satang) : item.image ?? null;
    const sameItem = change.field === 'price'
      ? tx`pos_product_id = ${item.pos_product_id} AND pos_variant_id IS NOT DISTINCT FROM ${item.pos_variant_id}`
      : tx`pos_product_id = ${item.pos_product_id}`;
    await tx`
      UPDATE menu_change_requests SET status = 'superseded', resolved_at = now()
      WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND field = ${change.field}
        AND status IN ('pending', 'conflict') AND ${sameItem}`;
    if (base === change.value) return { unchanged: true as const };
    const [row] = await tx`
      INSERT INTO menu_change_requests
        (tenant_id, branch_id, menu_item_id, pos_product_id, pos_variant_id, field, base_value, new_value, requested_by)
      VALUES (${scope.tenantId}, ${scope.branchId}, ${item.id}, ${item.pos_product_id},
              ${change.field === 'price' ? item.pos_variant_id : null}, ${change.field}, ${base}, ${change.value}, ${scope.userId})
      RETURNING id`;
    return { id: row.id as string };
  });
}

export async function branchMenu(sql: Sql, tenantId: string, branchId: string) {
  const items = await sql`
    SELECT id, name, category, price_satang, image, pos_product_id, pos_variant_id
    FROM menu_items
    WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND available AND pos_product_id IS NOT NULL
    ORDER BY category NULLS LAST, name, id`;
  const changes = await sql`
    SELECT c.id, c.menu_item_id, c.field, c.base_value, c.new_value, c.status, c.force, c.pos_value, c.detail,
           c.created_at, c.resolved_at, m.name AS item_name, u.display_name AS requested_by
    FROM menu_change_requests c
    JOIN menu_items m ON m.id = c.menu_item_id
    LEFT JOIN portal_users u ON u.id = c.requested_by
    WHERE c.tenant_id = ${tenantId} AND c.branch_id = ${branchId}
      AND (c.status IN ('pending', 'conflict') OR c.resolved_at > now() - interval '7 days')
      AND c.status <> 'superseded'
    ORDER BY c.created_at DESC LIMIT 200`;
  return { items, changes };
}

/** Owner decision on a conflict: send the web value again (overriding POS) or keep the POS value. */
export async function resolveConflict(sql: Sql, tenantId: string, changeId: string, keep: 'web' | 'pos') {
  const [row] = keep === 'web'
    ? await sql`UPDATE menu_change_requests SET status = 'pending', force = true, resolved_at = NULL
        WHERE id = ${changeId} AND tenant_id = ${tenantId} AND status = 'conflict' RETURNING id, branch_id`
    : await sql`UPDATE menu_change_requests SET status = 'kept_pos', resolved_at = now()
        WHERE id = ${changeId} AND tenant_id = ${tenantId} AND status = 'conflict' RETURNING id, branch_id`;
  return row ?? null;
}

export async function cancelChange(sql: Sql, tenantId: string, changeId: string) {
  const [row] = await sql`UPDATE menu_change_requests SET status = 'cancelled', resolved_at = now()
    WHERE id = ${changeId} AND tenant_id = ${tenantId} AND status IN ('pending', 'conflict') RETURNING id, branch_id`;
  return row ?? null;
}

interface Options {
  sql: Sql;
  authorize(request: Request): Promise<ConnectorIdentity | null>;
}

/** Connector side: the POS pulls pending owner changes and reports what it did with each. */
export function connectorMenuChanges({ sql, authorize }: Options) {
  return new Elysia()
    .get('/api/v1/connectors/menu-changes', async ({ request }) => {
      const scope = await authorize(request);
      if (!scope) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      const changes = await inTenant(sql, scope, (tx) => tx`
        SELECT c.id, c.pos_product_id, c.pos_variant_id, c.field, c.base_value, c.new_value, c.force,
               CASE WHEN c.field = 'image' THEN translate(encode(i.bytes, 'base64'), E'
', '') END AS image_data
        FROM menu_change_requests c
        LEFT JOIN menu_images i ON c.field = 'image' AND i.tenant_id = c.tenant_id AND i.name = c.new_value
        WHERE c.tenant_id = ${scope.tenantId} AND c.branch_id = ${scope.branchId} AND c.status = 'pending'
        ORDER BY c.created_at LIMIT 10`);
      return { changes };
    })
    .post('/api/v1/connectors/menu-changes/:id/result', async ({ request, params, body }) => {
      const scope = await authorize(request);
      if (!scope) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      const outcome = await inTenant(sql, scope, async (tx) => {
        const status = body.outcome === 'applied' ? 'applied' : body.outcome === 'conflict' ? 'conflict' : 'failed';
        const [change] = await tx`
          UPDATE menu_change_requests
          SET status = ${status}, pos_value = ${body.pos_value ?? null}, detail = ${body.detail ?? null}, resolved_at = now()
          WHERE id = ${params.id} AND tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND status = 'pending'
          RETURNING field, new_value, pos_product_id, pos_variant_id`;
        if (!change) return false;
        if (status === 'applied' && change.field === 'price') {
          await tx`UPDATE menu_items SET price_satang = ${Number(change.new_value)}, updated_at = now()
            WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId}
              AND pos_product_id = ${change.pos_product_id} AND pos_variant_id IS NOT DISTINCT FROM ${change.pos_variant_id}`;
        } else if (status === 'applied') {
          await tx`UPDATE menu_items SET image = ${change.new_value}, updated_at = now()
            WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND pos_product_id = ${change.pos_product_id}`;
        }
        return true;
      });
      return outcome ? { ok: true } : new Response(JSON.stringify({ error: 'change not pending' }), { status: 404 });
    }, {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        outcome: t.Union([t.Literal('applied'), t.Literal('conflict'), t.Literal('failed')]),
        pos_value: t.Optional(t.Union([t.Null(), t.String({ maxLength: 80 })])),
        detail: t.Optional(t.String({ maxLength: 200 })),
      }),
    });
}
