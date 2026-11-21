import type { Sql, TransactionSql } from 'postgres';

export interface TenantScope {
  tenantId: string;
  /** Omitted for tenant-wide rows; branch tables then expose nothing. */
  branchId?: string;
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Confines the rest of this transaction to one branch: row-level security applies to qr_app. */
export async function enterTenant(tx: TransactionSql, { tenantId, branchId }: TenantScope) {
  if (!UUID.test(tenantId) || (branchId !== undefined && !UUID.test(branchId))) throw Error('invalid tenant scope');
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.branch_id', ${branchId ?? ''}, true)`;
  await tx`SET LOCAL ROLE qr_app`;
}

export function inTenant<T>(sql: Sql, scope: TenantScope, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await enterTenant(tx, scope);
    return run(tx);
  }) as Promise<T>;
}
