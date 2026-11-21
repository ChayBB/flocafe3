import type { Sql, TransactionSql } from 'postgres';

export const MODULES = ['qr_ordering', 'menu_editing', 'reports'] as const;
export type Module = (typeof MODULES)[number];

/** True unless an administrator turned the module off for this branch. */
export async function moduleEnabled(q: Sql | TransactionSql, tenantId: string, branchId: string, module: Module) {
  const [row] = await q<{ enabled: boolean }[]>`
    SELECT enabled FROM branch_modules WHERE tenant_id = ${tenantId} AND branch_id = ${branchId} AND module = ${module}`;
  return row?.enabled ?? true;
}

/** Branch ids of a shop that have the module on. */
export async function branchesWithModule(sql: Sql, tenantId: string, module: Module) {
  const rows = await sql<{ id: string }[]>`
    SELECT b.id FROM branches b
    WHERE b.tenant_id = ${tenantId} AND NOT EXISTS (
      SELECT 1 FROM branch_modules m WHERE m.tenant_id = b.tenant_id AND m.branch_id = b.id AND m.module = ${module} AND NOT m.enabled)`;
  return rows.map((row) => row.id);
}

export async function setModule(sql: Sql, tenantId: string, branchId: string, module: Module, enabled: boolean) {
  await sql`
    INSERT INTO branch_modules (tenant_id, branch_id, module, enabled) VALUES (${tenantId}, ${branchId}, ${module}, ${enabled})
    ON CONFLICT (tenant_id, branch_id, module) DO UPDATE SET enabled = excluded.enabled, updated_at = now()`;
}

/** SQL fragment: a JSON object of every module and whether it is on for branch alias `b`. */
export const modulesJson = (sql: Sql) => sql`(
  SELECT jsonb_object_agg(k.module, coalesce(m.enabled, true))
  FROM unnest(${MODULES as unknown as string[]}::text[]) AS k(module)
  LEFT JOIN branch_modules m ON m.tenant_id = b.tenant_id AND m.branch_id = b.id AND m.module = k.module)`;
