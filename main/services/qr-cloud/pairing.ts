import { getDatabase, recordAuthAudit, upsertSettings } from '../../db';
import {
  QR_CLOUD_SETTING_KEYS,
  readConfig,
  updateConfig,
  validateConnectorToken,
  writeConnectorToken,
} from './config';
import { QrCloudClientError, redeemConnectorPairingCode } from './client';
import { startQrCloudConnector, testQrCloudConnection } from './connector';
import { readApprovedCa } from './tls';

/** The production Cloud; a shop that already points at another real Cloud keeps it. */
export const DEFAULT_QR_CLOUD_URL = 'https://qr-ordering.accesscam.org';
const STAGING_URL = 'https://qr-staging.test';
const PAIRING_CODE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

export class PairingError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

let redeem = redeemConnectorPairingCode;

export function __setPairingRedeemForTests(fn: typeof redeemConnectorPairingCode | null): void {
  redeem = fn ?? redeemConnectorPairingCode;
}

export function normalizePairingCode(raw: unknown): string {
  const code = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!PAIRING_CODE.test(code)) throw new PairingError('pairing_code_invalid', 400);
  return code;
}

function pairingFailure(error: unknown): PairingError {
  if (error instanceof QrCloudClientError) {
    if (error.detail === 'HTTP 404') return new PairingError('pairing_code_rejected', 404);
    if (error.detail === 'HTTP 429') return new PairingError('pairing_rate_limited', 429);
    return new PairingError(error.code, error.code === 'timeout' ? 504 : 502);
  }
  return new PairingError('bad_response', 502);
}

/**
 * Exchanges a one-time Cloud pairing code for this POS's connector token, then tests the
 * connection and starts polling when it succeeds. A failed test still leaves the POS paired.
 */
export async function pairQrCloud(actor: string, rawCode: unknown) {
  const code = normalizePairingCode(rawCode);
  const config = readConfig();
  const cloudUrl =
    config.cloudUrl && config.cloudUrl !== STAGING_URL ? config.cloudUrl : DEFAULT_QR_CLOUD_URL;
  let response: unknown;
  try {
    response = await redeem(
      {
        config: { ...config, cloudUrl },
        caPem: readApprovedCa()?.pem ?? null,
        signal: AbortSignal.timeout(config.timeoutMs),
      },
      code,
    );
  } catch (error) {
    throw pairingFailure(error);
  }
  const paired = response as Record<string, unknown> | null;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() && value.length <= 100 ? value.trim() : null;
  const tenantName = text(paired?.tenant_name);
  const branchName = text(paired?.branch_name);
  let token: string;
  try {
    token = validateConnectorToken(paired?.connector_token);
  } catch {
    throw new PairingError('bad_response', 502);
  }
  if (!tenantName || !branchName) throw new PairingError('bad_response', 502);

  writeConnectorToken(token);
  const db = getDatabase();
  db.transaction(() => {
    upsertSettings({
      [QR_CLOUD_SETTING_KEYS.cutoverPending]: '0',
      [QR_CLOUD_SETTING_KEYS.pairedBranch]: `${tenantName} · ${branchName}`,
    });
    updateConfig({ mode: 'integrated', cloudUrl, automatic: false });
    recordAuthAudit(db, {
      userId: actor,
      eventType: 'qr_cloud_paired',
      outcome: 'success',
      details: { cloud_url: cloudUrl, tenant: tenantName, branch: branchName },
    });
  })();
  const test = await testQrCloudConnection();
  if (test.ok) updateConfig({ enabled: true });
  startQrCloudConnector({ force: true });
  return { tenant_name: tenantName, branch_name: branchName, test };
}
