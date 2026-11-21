import type { Sql } from 'postgres';
import { randomInt } from 'node:crypto';
import { sha256 } from '../../../packages/shared/src/index';
import { connectorScopes, issueConnectorToken } from './connector-auth';

/** No 0/O, 1/I/L or U, so a code read aloud or over the phone is hard to mistype. */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MINUTES = 30;

export function normalizePairingCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return code.length === PAIRING_CODE_LENGTH && [...code].every((c) => PAIRING_ALPHABET.includes(c))
    ? code
    : null;
}

export const formatPairingCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Issues a fresh code for one branch; any unused earlier code for that branch stops working. */
export async function createPairingCode(sql: Sql, scope: { tenantId: string; branchId: string; label: string }) {
  const code = Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('');
  const row = await sql.begin(async (tx) => {
    await tx`DELETE FROM connector_pairing_codes
      WHERE tenant_id = ${scope.tenantId} AND branch_id = ${scope.branchId} AND used_at IS NULL`;
    const [inserted] = await tx<{ expires_at: Date }[]>`
      INSERT INTO connector_pairing_codes(code_hash, tenant_id, branch_id, label, expires_at)
      VALUES (${sha256(code)}, ${scope.tenantId}, ${scope.branchId}, ${scope.label},
              now() + make_interval(mins => ${PAIRING_TTL_MINUTES}))
      RETURNING expires_at`;
    return inserted;
  });
  return { code: formatPairingCode(code), expires_at: row.expires_at };
}

/**
 * Spends a code once. A branch that already has a POS keeps its installation (and its table QR
 * links) but gets a new token, so the replaced POS stops working immediately.
 */
export async function redeemPairingCode(sql: Sql, raw: string) {
  const code = normalizePairingCode(raw);
  if (!code) return null;
  return sql.begin(async (tx) => {
    const [claim] = await tx`
      UPDATE connector_pairing_codes SET used_at = now()
      WHERE code_hash = ${sha256(code)} AND used_at IS NULL AND expires_at > now()
      RETURNING tenant_id, branch_id, label`;
    if (!claim) return null;
    const [active] = await tx`
      SELECT id FROM connector_installations
      WHERE tenant_id = ${claim.tenant_id} AND branch_id = ${claim.branch_id} AND revoked_at IS NULL
      FOR UPDATE`;
    const issued = await issueConnectorToken(tx as unknown as Sql, {
      tenant_id: claim.tenant_id,
      branch_id: claim.branch_id,
      label: claim.label,
      scopes: [...connectorScopes],
      installation_id: active?.id,
    });
    if (!issued) return null;
    const [names] = await tx`
      SELECT t.name AS tenant_name, b.name AS branch_name
      FROM branches b JOIN tenants t ON t.id = b.tenant_id
      WHERE b.tenant_id = ${claim.tenant_id} AND b.id = ${claim.branch_id}`;
    return { ...issued, tenant_name: names.tenant_name as string, branch_name: names.branch_name as string };
  });
}

/** Per-client attempt window held in memory: the API runs as one process. */
export function attemptLimiter(max: number, windowMs: number, now = () => Date.now()) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(client: string) {
      const at = now();
      if (windows.size > 10_000) for (const [key, entry] of windows) if (entry.resetAt <= at) windows.delete(key);
      const entry = windows.get(client);
      if (!entry || entry.resetAt <= at) {
        windows.set(client, { count: 1, resetAt: at + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}
