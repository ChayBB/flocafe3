import type { Sql } from 'postgres';
import { sha256 } from '../../../packages/shared/src/index';
import type { ConnectorIdentity } from './connector-auth';
import type { AddonGroup } from './catalog-addons';

export interface CatalogItem {
  external_id: string;
  pos_product_id: string;
  pos_variant_id: string | null;
  name: string;
  category: string | null;
  price_satang: number;
  addon_groups?: AddonGroup[];
}

export async function publishCatalog(sql: Sql, { tenantId, branchId }: ConnectorIdentity, input: {
  revision: string; base_revision: string | null; items: CatalogItem[];
}) {
  if (new Set(input.items.map(({ external_id }) => external_id)).size !== input.items.length ||
      input.items.some((item) => item.external_id !== (item.pos_variant_id ? `variant:${item.pos_variant_id}` : item.pos_product_id))) return 'invalid';
  const snapshot = JSON.stringify(input.items);
  const hash = sha256(snapshot);
  return sql.begin(async (tx) => {
    const [branch] = await tx`
      SELECT menu_revision, menu_revision_hash FROM branches
      WHERE tenant_id = ${tenantId} AND id = ${branchId} FOR UPDATE
    `;
    if (!branch) return 'missing';
    if (branch.menu_revision === input.revision) return branch.menu_revision_hash === hash ? 'published' : 'conflict';
    if (branch.menu_revision !== input.base_revision) return 'conflict';
    const [remapped] = await tx`
      SELECT 1 FROM menu_items m
      JOIN jsonb_to_recordset(${snapshot}::text::jsonb) AS item(
        external_id text, pos_product_id text, pos_variant_id text
      ) ON item.external_id = m.external_id
      WHERE m.tenant_id = ${tenantId} AND m.branch_id = ${branchId} AND m.pos_product_id IS NOT NULL
        AND (m.pos_product_id IS DISTINCT FROM item.pos_product_id OR m.pos_variant_id IS DISTINCT FROM item.pos_variant_id)
      LIMIT 1
    `;
    if (remapped) return 'conflict';
    await tx`
      INSERT INTO menu_items (tenant_id, branch_id, external_id, name, price_satang, available,
        category, pos_product_id, pos_variant_id, addon_groups)
      SELECT ${tenantId}, ${branchId}, item.external_id, item.name, item.price_satang, true,
        item.category, item.pos_product_id, item.pos_variant_id, coalesce(item.addon_groups, '[]'::jsonb)
      FROM jsonb_to_recordset(${snapshot}::text::jsonb) AS item(
        external_id text, name text, price_satang int, category text, pos_product_id text, pos_variant_id text, addon_groups jsonb
      )
      ON CONFLICT (tenant_id, branch_id, external_id) DO UPDATE
      SET name = excluded.name, price_satang = excluded.price_satang, available = true,
        category = excluded.category, pos_product_id = excluded.pos_product_id,
        pos_variant_id = excluded.pos_variant_id, addon_groups = excluded.addon_groups, updated_at = now()
    `;
    await tx`
      UPDATE menu_items SET available = false, updated_at = now()
      WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND available
        AND NOT coalesce(external_id = ANY(${input.items.map((item) => item.external_id)}::text[]), false)
    `;
    await tx`
      UPDATE branches SET menu_revision = ${input.revision}, menu_revision_hash = ${hash}
      WHERE tenant_id = ${tenantId} AND id = ${branchId}
    `;
    return 'published';
  });
}
