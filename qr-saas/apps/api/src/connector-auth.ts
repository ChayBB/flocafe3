import type { Sql } from 'postgres';
import { bearer, constantEqual, sha256, token } from '../../../packages/shared/src/index';

export const connectorScopes = ['orders.read', 'orders.ack', 'tables.write', 'catalog.write'] as const;
export type ConnectorPermission = typeof connectorScopes[number];

export interface ConnectorIdentity {
  tenantId: string;
  branchId: string;
  installationId: string | null;
}

export function connectorAuthorizer(sql: Sql, legacy?: { tenantId: string; branchId: string; token: string }) {
  return async (request: Request, permission: ConnectorPermission): Promise<ConnectorIdentity | null> => {
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [!-~]{24,512}$/i.test(authorization)) return null;
    const secret = bearer(request);
    const [row] = await sql`
      SELECT id, tenant_id, branch_id, scopes FROM connector_installations
      WHERE token_hash = ${sha256(secret)} AND revoked_at IS NULL
    `;
    if (row) return row.scopes.includes(permission)
      ? { tenantId: row.tenant_id, branchId: row.branch_id, installationId: row.id } : null;
    if (!legacy || !constantEqual(secret, legacy.token) || permission === 'orders.ack' || permission === 'catalog.write') return null;
    const [registered] = await sql`
      SELECT 1 FROM connector_installations
      WHERE tenant_id = ${legacy.tenantId} AND branch_id = ${legacy.branchId}
    `;
    return registered ? null : { tenantId: legacy.tenantId, branchId: legacy.branchId, installationId: null };
  };
}

export async function issueConnectorToken(sql: Sql, input: {
  tenant_id: string; branch_id: string; label: string; scopes: ConnectorPermission[];
  installation_id?: string;
}) {
  const secret = token();
  const hash = sha256(secret);
  const [row] = input.installation_id
    ? await sql`
      UPDATE connector_installations SET token_hash = ${hash}, scopes = ${input.scopes}, label = ${input.label}, revoked_at = NULL
      WHERE id = ${input.installation_id} AND tenant_id = ${input.tenant_id} AND branch_id = ${input.branch_id}
      RETURNING id
    `
    : await sql`
      INSERT INTO connector_installations(tenant_id, branch_id, label, token_hash, scopes)
      VALUES (${input.tenant_id}, ${input.branch_id}, ${input.label}, ${hash}, ${input.scopes}) RETURNING id
    `;
  return row ? { installation_id: row.id, connector_token: secret } : null;
}
