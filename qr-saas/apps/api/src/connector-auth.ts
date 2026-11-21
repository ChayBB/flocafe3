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
    if (row) {
      void sql`UPDATE connector_installations SET last_seen_at = now()
        WHERE id = ${row.id} AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`.catch(() => {});
      return row.scopes.includes(permission)
        ? { tenantId: row.tenant_id, branchId: row.branch_id, installationId: row.id } : null;
    }
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

/** Revokes a POS installation and stops its table QR sessions; table stickers stay registered. */
export async function revokeInstallation(sql: Sql, scope: { installationId?: string; tenantId: string; branchId: string }) {
  return sql.begin(async (tx) => {
    const [revoked] = scope.installationId
      ? await tx`UPDATE connector_installations SET revoked_at = coalesce(revoked_at, now())
          WHERE id = ${scope.installationId} AND tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} RETURNING id`
      : await tx`UPDATE connector_installations SET revoked_at = now()
          WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND revoked_at IS NULL RETURNING id`;
    if (!revoked) return false;
    await tx`UPDATE dining_tables SET qr_ordering_until = NULL WHERE pos_installation_id = ${revoked.id}
      AND tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId}`;
    await tx`UPDATE table_sessions s SET revoked_at = now() FROM dining_tables d
      WHERE (s.tenant_id, s.branch_id, s.table_id) = (d.tenant_id, d.branch_id, d.id)
        AND d.pos_installation_id = ${revoked.id} AND d.tenant_id = ${scope.tenantId} AND d.branch_id = ${scope.branchId}
        AND s.revoked_at IS NULL AND s.expires_at > now()`;
    return true;
  });
}
