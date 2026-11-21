import { getDatabase, getSettingValue, recordAuthAudit, upsertSettings } from '../../db';
import { readProtectedSetting } from '../../security/protected-setting';
import { QR_CLOUD_SETTING_KEYS, QR_CLOUD_TOKEN_KEY, readConfig, updateConfig } from './config';
import { startQrCloudConnector, testQrCloudConnection } from './connector';
import { readApprovedCa } from './tls';

export class QrCloudSetupError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

function targetState() {
  return {
    config: readConfig(),
    tokenMarker: getSettingValue(QR_CLOUD_TOKEN_KEY) ?? '',
    token: readProtectedSetting(QR_CLOUD_TOKEN_KEY, true, false),
    caFingerprint: getSettingValue(QR_CLOUD_SETTING_KEYS.caFingerprint) ?? '',
    verifiedCa: readApprovedCa()?.fingerprint_sha256 ?? '',
  };
}

/**
 * Tests the saved connection and, when it passes, starts polling. A pending cutover hold from an
 * older install needs confirmation that the previous Connector is stopped and is cleared here.
 */
export async function activateQrCloudSetup(actor: string, confirmed: unknown) {
  const state = targetState();
  const { cutoverPending, enabled, mode } = state.config;
  if (enabled || mode !== 'integrated') throw new QrCloudSetupError('legacy_cutover_not_pending', 409);
  if (cutoverPending && confirmed !== true) throw new QrCloudSetupError('confirmation_required');
  const test = await testQrCloudConnection();
  if (!test.ok) return test;
  if (JSON.stringify(targetState()) !== JSON.stringify(state))
    throw new QrCloudSetupError('legacy_preview_stale', 409);
  const db = getDatabase();
  db.transaction(() => {
    if (cutoverPending) {
      upsertSettings({ [QR_CLOUD_SETTING_KEYS.cutoverPending]: '0' });
      recordAuthAudit(db, {
        userId: actor,
        eventType: 'qr_cloud_legacy_cutover_verified',
        outcome: 'success',
      });
    }
    updateConfig({ enabled: true });
  })();
  startQrCloudConnector({ force: true });
  return test;
}
