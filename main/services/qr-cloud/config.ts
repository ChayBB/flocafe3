import { getSettingValue, upsertSettings } from '../../db';
import { readProtectedSetting, writeProtectedSetting } from '../../security/protected-setting';
import { isBlockedSsrfTarget } from '../../middleware/security';

/**
 * Cloud QR Ordering connector configuration.
 *
 * The integrated connector is inbox-only: it polls the Cloud event feed and stores events
 * durably. It never creates POS orders, never sends an ACK, and never changes Cloud state.
 */

export const QR_CLOUD_SETTING_KEYS = {
  enabled: 'qr_cloud_enabled',
  mode: 'qr_cloud_mode',
  cloudUrl: 'qr_cloud_url',
  connectionMode: 'qr_cloud_connection_mode',
  pollIntervalMs: 'qr_cloud_poll_interval_ms',
  autoStart: 'qr_cloud_auto_start',
  retryMax: 'qr_cloud_retry_max',
  timeoutMs: 'qr_cloud_timeout_ms',
  reconcileIntervalMs: 'qr_cloud_reconcile_interval_ms',
  lastSuccessAt: 'qr_cloud_last_success_at',
  lastError: 'qr_cloud_last_error',
  lastErrorAt: 'qr_cloud_last_error_at',
  lastOrderFetchAt: 'qr_cloud_last_order_fetch_at',
  caFingerprint: 'qr_cloud_ca_fingerprint',
  caSubject: 'qr_cloud_ca_subject',
  caNotAfter: 'qr_cloud_ca_not_after',
  importedAt: 'qr_cloud_inbox_imported_at',
} as const;

/** The bearer token lives in OS-protected storage; the settings row only carries a marker. */
export const QR_CLOUD_TOKEN_KEY = 'qr_cloud_connector_token';

export type QrCloudMode = 'legacy_relay' | 'integrated';
export type QrCloudConnectionMode = 'auto' | 'polling';

export interface QrCloudConfig {
  enabled: boolean;
  mode: QrCloudMode;
  cloudUrl: string;
  connectionMode: QrCloudConnectionMode;
  pollIntervalMs: number;
  autoStart: boolean;
  retryMax: number;
  timeoutMs: number;
  reconcileIntervalMs: number;
}

export const DEFAULT_CONFIG: QrCloudConfig = {
  enabled: false,
  mode: 'integrated',
  cloudUrl: '',
  connectionMode: 'auto',
  pollIntervalMs: 15_000,
  autoStart: true,
  retryMax: 5,
  timeoutMs: 10_000,
  reconcileIntervalMs: 120_000,
};

export const POLL_INTERVAL_MIN_MS = 5_000;
export const POLL_INTERVAL_MAX_MS = 300_000;
export const TIMEOUT_MIN_MS = 2_000;
export const TIMEOUT_MAX_MS = 60_000;
export const RETRY_MIN = 1;
export const RETRY_MAX = 10;
export const RECONCILE_MIN_MS = 30_000;
export const RECONCILE_MAX_MS = 3_600_000;

export class QrCloudConfigError extends Error {
  constructor(public code: QrCloudConfigErrorCode) {
    super(code);
  }
}

export type QrCloudConfigErrorCode =
  | 'cloud_url_invalid'
  | 'cloud_url_not_https'
  | 'cloud_url_private_target'
  | 'poll_interval_invalid'
  | 'timeout_invalid'
  | 'retry_invalid'
  | 'reconcile_invalid'
  | 'mode_invalid'
  | 'connection_mode_invalid';

function clampInt(value: unknown, min: number, max: number, code: QrCloudConfigErrorCode): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new QrCloudConfigError(code);
  return parsed;
}

/**
 * An https Cloud origin only: no credentials, query or fragment, no plain http, and no literal
 * address inside the shop, the host itself or a link-local/metadata range. DNS is re-checked on
 * every request so a name cannot later resolve to a private address.
 */
export function normalizeCloudUrl(value: unknown): string {
  if (typeof value !== 'string') throw new QrCloudConfigError('cloud_url_invalid');
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200) throw new QrCloudConfigError('cloud_url_invalid');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new QrCloudConfigError('cloud_url_invalid');
  }
  if (url.protocol !== 'https:') throw new QrCloudConfigError('cloud_url_not_https');
  if (url.username || url.password || url.search || url.hash)
    throw new QrCloudConfigError('cloud_url_invalid');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!literal && (host === 'localhost' || host.endsWith('.localhost')))
    throw new QrCloudConfigError('cloud_url_private_target');
  if (literal && isBlockedSsrfTarget(host))
    throw new QrCloudConfigError('cloud_url_private_target');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function readConfig(): QrCloudConfig {
  const raw = (key: string) => getSettingValue(QR_CLOUD_SETTING_KEYS[key as never]);
  const mode = raw('mode') === 'legacy_relay' ? 'legacy_relay' : 'integrated';
  const connectionMode = raw('connectionMode') === 'polling' ? 'polling' : 'auto';
  const int = (value: string | null, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    enabled: raw('enabled') === '1',
    mode,
    cloudUrl: raw('cloudUrl') || '',
    connectionMode,
    pollIntervalMs: int(raw('pollIntervalMs'), DEFAULT_CONFIG.pollIntervalMs),
    autoStart: raw('autoStart') !== '0',
    retryMax: int(raw('retryMax'), DEFAULT_CONFIG.retryMax),
    timeoutMs: int(raw('timeoutMs'), DEFAULT_CONFIG.timeoutMs),
    reconcileIntervalMs: int(raw('reconcileIntervalMs'), DEFAULT_CONFIG.reconcileIntervalMs),
  };
}

export interface QrCloudConfigPatch {
  enabled?: boolean;
  mode?: QrCloudMode;
  cloudUrl?: string;
  connectionMode?: QrCloudConnectionMode;
  pollIntervalMs?: number;
  autoStart?: boolean;
  retryMax?: number;
  timeoutMs?: number;
  reconcileIntervalMs?: number;
}

/** Validates and persists a settings patch, returning the config that is now in force. */
export function updateConfig(patch: QrCloudConfigPatch): QrCloudConfig {
  const current = readConfig();
  const next: QrCloudConfig = { ...current };
  const writes: Record<string, string> = {};

  if (patch.enabled !== undefined) {
    next.enabled = Boolean(patch.enabled);
    writes[QR_CLOUD_SETTING_KEYS.enabled] = next.enabled ? '1' : '0';
  }
  if (patch.autoStart !== undefined) {
    next.autoStart = Boolean(patch.autoStart);
    writes[QR_CLOUD_SETTING_KEYS.autoStart] = next.autoStart ? '1' : '0';
  }
  if (patch.mode !== undefined) {
    if (patch.mode !== 'legacy_relay' && patch.mode !== 'integrated')
      throw new QrCloudConfigError('mode_invalid');
    next.mode = patch.mode;
    writes[QR_CLOUD_SETTING_KEYS.mode] = next.mode;
  }
  if (patch.connectionMode !== undefined) {
    if (patch.connectionMode !== 'auto' && patch.connectionMode !== 'polling')
      throw new QrCloudConfigError('connection_mode_invalid');
    next.connectionMode = patch.connectionMode;
    writes[QR_CLOUD_SETTING_KEYS.connectionMode] = next.connectionMode;
  }
  if (patch.cloudUrl !== undefined) {
    next.cloudUrl = patch.cloudUrl.trim() === '' ? '' : normalizeCloudUrl(patch.cloudUrl);
    writes[QR_CLOUD_SETTING_KEYS.cloudUrl] = next.cloudUrl;
  }
  if (patch.pollIntervalMs !== undefined) {
    next.pollIntervalMs = clampInt(
      patch.pollIntervalMs,
      POLL_INTERVAL_MIN_MS,
      POLL_INTERVAL_MAX_MS,
      'poll_interval_invalid',
    );
    writes[QR_CLOUD_SETTING_KEYS.pollIntervalMs] = String(next.pollIntervalMs);
  }
  if (patch.timeoutMs !== undefined) {
    next.timeoutMs = clampInt(patch.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, 'timeout_invalid');
    writes[QR_CLOUD_SETTING_KEYS.timeoutMs] = String(next.timeoutMs);
  }
  if (patch.retryMax !== undefined) {
    next.retryMax = clampInt(patch.retryMax, RETRY_MIN, RETRY_MAX, 'retry_invalid');
    writes[QR_CLOUD_SETTING_KEYS.retryMax] = String(next.retryMax);
  }
  if (patch.reconcileIntervalMs !== undefined) {
    next.reconcileIntervalMs = clampInt(
      patch.reconcileIntervalMs,
      RECONCILE_MIN_MS,
      RECONCILE_MAX_MS,
      'reconcile_invalid',
    );
    writes[QR_CLOUD_SETTING_KEYS.reconcileIntervalMs] = String(next.reconcileIntervalMs);
  }

  if (Object.keys(writes).length > 0) upsertSettings(writes);
  return next;
}

/** Stores a replacement bearer token. An empty value clears it. Never readable back through the API. */
export function writeConnectorToken(raw: unknown): void {
  if (typeof raw !== 'string') throw new QrCloudConfigError('cloud_url_invalid');
  const token = raw.trim();
  if (token.length > 512 || /\s/.test(token)) throw new QrCloudConfigError('cloud_url_invalid');
  writeProtectedSetting(QR_CLOUD_TOKEN_KEY, token);
}

export function hasConnectorToken(): boolean {
  return readConnectorSetting() !== '';
}

export function readConnectorSetting(): string {
  return readProtectedSetting(QR_CLOUD_TOKEN_KEY) || '';
}

export function clearConnectorToken(): void {
  writeProtectedSetting(QR_CLOUD_TOKEN_KEY, '');
}
