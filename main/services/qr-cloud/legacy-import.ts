import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDatabase, getSettingValue, recordAuthAudit, upsertSettings } from '../../db';
import {
  commitProtectedSetting,
  ProtectedStorageUnavailableError,
  readProtectedSetting,
} from '../../security/protected-setting';
import {
  normalizeCloudUrl,
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MIN_MS,
  QR_CLOUD_SETTING_KEYS,
  QR_CLOUD_TOKEN_KEY,
  QrCloudConfigError,
  type QrCloudConfigErrorCode,
  readConfig,
  updateConfig,
  validateConnectorToken,
} from './config';
import { startQrCloudConnector, stopQrCloudConnector, testQrCloudConnection } from './connector';
import {
  approveCaCertificate,
  CaCertificateError,
  inspectCaBasicConstraints,
  inspectCaCertificate,
  MAX_CERTIFICATE_BYTES,
  normalizeFingerprint,
  readApprovedCa,
} from './tls';

const LEGACY_ROOT = 'C:\\QRConnector';
const MAX_ENV_BYTES = 8 * 1024;
const PREVIEW_TTL_MS = 5 * 60_000;
const previewKey = randomBytes(32);
const STAGING_CA =
  'DF:EF:50:4A:23:0B:F8:ED:6E:5E:A4:E9:E8:78:EA:C2:FD:93:FE:57:41:4C:FD:34:C8:44:95:7A:18:7E:3D:5F';

export class LegacyImportError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

function checkPath(file: string): fs.Stats {
  const ancestors: string[] = [];
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    ancestors.push(parent);
    if (parent === path.dirname(parent)) break;
  }
  for (const parent of ancestors.reverse()) {
    const entry = fs.lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new LegacyImportError('legacy_unsafe_file');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new LegacyImportError('legacy_unsafe_file');
  if (path.relative(file, fs.realpathSync.native(file)) !== '')
    throw new LegacyImportError('legacy_unsafe_file');
  return stat;
}

function readSource(file: string, limit: number): Buffer | null {
  try {
    const before = checkPath(file);
    if (before.size > limit) throw new LegacyImportError('legacy_file_too_large');
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = fs.fstatSync(fd);
      const after = checkPath(file);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.dev !== after.dev ||
        opened.ino !== after.ino
      )
        throw new LegacyImportError('legacy_unsafe_file');
      const buffer = Buffer.alloc(limit + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!count) break;
        bytes += count;
      }
      if (bytes > limit) throw new LegacyImportError('legacy_file_too_large');
      const final = fs.fstatSync(fd);
      if (bytes !== opened.size || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs)
        throw new LegacyImportError('legacy_source_changed', 409);
      return buffer.subarray(0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError('legacy_file_unreadable');
  }
}

function parseEnv(bytes: Buffer): Map<string, string> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new LegacyImportError('legacy_env_invalid');
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const separator = entry.indexOf('=');
    const key = entry
      .slice(0, separator)
      .trimEnd()
      .replace(/^export[ \t]+/, '');
    if (
      separator < 1 ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
      line.includes('\0') ||
      line.includes('\r') ||
      values.has(key)
    )
      throw new LegacyImportError('legacy_env_invalid');
    const raw = entry.slice(separator + 1).trimStart();
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const end = raw.indexOf(raw[0], 1);
      const suffix = raw.slice(end + 1).trimStart();
      if (end < 0 || (suffix && !suffix.startsWith('#')))
        throw new LegacyImportError('legacy_env_invalid');
      values.set(key, raw.slice(1, end));
    } else {
      const comment = raw.indexOf('#');
      const value = (comment < 0 ? raw : raw.slice(0, comment)).trimEnd();
      if (/['"]/.test(value)) throw new LegacyImportError('legacy_env_invalid');
      values.set(key, value);
    }
  }
  return values;
}

function sourceConfig(bytes: Buffer) {
  const values = parseEnv(bytes);
  const errors: QrCloudConfigErrorCode[] = [];
  const validate = <T>(check: () => T): T | null => {
    try {
      return check();
    } catch (error) {
      if (!(error instanceof QrCloudConfigError)) throw error;
      errors.push(error.code);
      return null;
    }
  };
  const rawToken = values.get('CONNECTOR_TOKEN');
  const cloudUrl = validate(() => {
    const url = normalizeCloudUrl(values.get('CLOUD_URL'));
    if (
      url !== new URL(url).origin ||
      (rawToken && rawToken.length >= 24 && url.includes(rawToken))
    )
      throw new QrCloudConfigError('cloud_url_invalid');
    return url;
  });
  const token = validate(() => {
    const value = validateConnectorToken(rawToken);
    if (value.length < 24) throw new QrCloudConfigError('token_invalid');
    return value;
  });
  const pollIntervalMs = validate(() => {
    const interval = values.get('POLL_INTERVAL_MS') ?? '';
    const ms = Number(interval);
    if (!/^\d+$/.test(interval) || ms < POLL_INTERVAL_MIN_MS || ms > POLL_INTERVAL_MAX_MS)
      throw new QrCloudConfigError('poll_interval_invalid');
    return ms;
  });
  return { cloudUrl, token, pollIntervalMs, tokenPresent: Boolean(rawToken?.trim()), errors };
}

function publicCertificate(bytes: Buffer) {
  const text = bytes.toString('utf8');
  if (!/^\s*-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*$/.test(text))
    throw new CaCertificateError('certificate_invalid');
  const { subject, issuer, valid_from, valid_to, fingerprint_sha256, is_ca } =
    inspectCaCertificate(text);
  if (Date.parse(valid_from) > Date.now()) throw new CaCertificateError('certificate_invalid');
  return {
    subject,
    issuer,
    valid_from,
    valid_to,
    fingerprint_sha256,
    is_ca,
    basic_constraints: inspectCaBasicConstraints(text),
  };
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

function signPreview(
  expires: number,
  actor: string,
  source: Buffer,
  state: ReturnType<typeof targetState>,
) {
  return createHmac('sha256', previewKey)
    .update(JSON.stringify([expires, actor, state]))
    .update(source)
    .digest();
}

function sourcePaths(root: string) {
  if (root === LEGACY_ROOT && process.platform !== 'win32')
    throw new LegacyImportError('legacy_windows_only');
  return {
    env: path.join(root, 'config', 'connector.env'),
    ca: path.join(root, 'certs', 'root.crt'),
  };
}

/** The root override is only used by fixture callers. HTTP routes use the fixed legacy location. */
export function previewLegacyImport(actor: string, root = LEGACY_ROOT) {
  const paths = sourcePaths(root);
  const bytes = readSource(paths.env, MAX_ENV_BYTES);
  const state = targetState();
  const conflicts = [
    ...(state.config.cloudUrl ||
    state.config.enabled ||
    state.config.mode !== 'integrated' ||
    getSettingValue(QR_CLOUD_SETTING_KEYS.pollIntervalMs)
      ? ['configuration']
      : []),
    ...(state.tokenMarker ? ['credential'] : []),
    ...(state.caFingerprint ? ['certificate'] : []),
  ];
  let caFound = false;
  let caError: string | null = null;
  let certificate: ReturnType<typeof publicCertificate> | null = null;
  try {
    const ca = readSource(paths.ca, MAX_CERTIFICATE_BYTES);
    caFound = ca !== null;
    if (ca) certificate = publicCertificate(ca);
  } catch (error) {
    if (error instanceof CaCertificateError || error instanceof LegacyImportError)
      caError = error.code;
    else throw error;
  }
  const expires = Date.now() + PREVIEW_TTL_MS;
  let source: ReturnType<typeof sourceConfig> | null = null;
  let validationErrors: string[] = [];
  if (bytes) {
    try {
      source = sourceConfig(bytes);
      validationErrors = source.errors;
    } catch (error) {
      if (!(error instanceof LegacyImportError)) throw error;
      validationErrors = [error.code];
    }
  }
  const ready = bytes !== null && validationErrors.length === 0;
  return {
    source_found: bytes !== null,
    cloud_url: source?.cloudUrl ?? null,
    connector_token_present: source?.tokenPresent ?? (bytes ? null : false),
    poll_interval_ms: source?.pollIntervalMs ?? null,
    ca_certificate_found: caFound,
    ca_certificate: certificate,
    ca_error: caError,
    ca_matches_expected: certificate?.fingerprint_sha256 === STAGING_CA,
    conflicts,
    validation_errors: validationErrors,
    ready_for_import: ready,
    preview_id: ready
      ? `${expires}.${signPreview(expires, actor, bytes, state).toString('hex')}`
      : null,
  };
}

export function commitLegacyImport(
  actor: string,
  request: { preview_id?: unknown; confirm?: unknown; replace_credential?: unknown },
  root = LEGACY_ROOT,
): void {
  if (request.confirm !== true) throw new LegacyImportError('confirmation_required');
  const match =
    typeof request.preview_id === 'string'
      ? /^(\d{13})\.([a-f0-9]{64})$/.exec(request.preview_id)
      : null;
  const expires = Number(match?.[1]);
  if (!match || expires < Date.now()) throw new LegacyImportError('legacy_preview_stale', 409);
  const bytes = readSource(sourcePaths(root).env, MAX_ENV_BYTES);
  const state = targetState();
  if (
    !bytes ||
    !timingSafeEqual(signPreview(expires, actor, bytes, state), Buffer.from(match[2], 'hex'))
  )
    throw new LegacyImportError('legacy_preview_stale', 409);
  const { cloudUrl, token, pollIntervalMs, errors } = sourceConfig(bytes);
  if (!cloudUrl || !token || pollIntervalMs === null) throw new QrCloudConfigError(errors[0]);
  if (state.tokenMarker && request.replace_credential !== true)
    throw new LegacyImportError('legacy_replace_credential_required', 409);
  const db = getDatabase();
  try {
    commitProtectedSetting(QR_CLOUD_TOKEN_KEY, token, (marker) => {
      db.transaction(() => {
        updateConfig({ enabled: false, mode: 'integrated', cloudUrl, pollIntervalMs });
        upsertSettings({
          [QR_CLOUD_TOKEN_KEY]: marker,
          [QR_CLOUD_SETTING_KEYS.cutoverPending]: '1',
        });
        recordAuthAudit(db, {
          userId: actor,
          eventType: 'qr_cloud_legacy_config_import',
          outcome: 'success',
          details: { replaced_credential: Boolean(state.tokenMarker) },
        });
      })();
    });
  } catch (error) {
    if (error instanceof ProtectedStorageUnavailableError)
      throw new QrCloudConfigError('credential_storage_unavailable');
    throw error;
  }
  stopQrCloudConnector();
}

export function importLegacyCa(
  request: { confirm?: unknown; expected_fingerprint?: unknown },
  root = LEGACY_ROOT,
) {
  if (request.confirm !== true) throw new LegacyImportError('confirmation_required');
  const config = readConfig();
  if (!config.cutoverPending || config.cloudUrl !== 'https://qr-staging.test')
    throw new LegacyImportError('legacy_ca_requires_staging_import', 409);
  const bytes = readSource(sourcePaths(root).ca, MAX_CERTIFICATE_BYTES);
  if (!bytes) throw new LegacyImportError('legacy_ca_missing', 404);
  const info = publicCertificate(bytes);
  const expected = normalizeFingerprint(request.expected_fingerprint);
  if (expected !== STAGING_CA || expected !== info.fingerprint_sha256)
    throw new CaCertificateError('fingerprint_mismatch');
  const existing = getSettingValue(QR_CLOUD_SETTING_KEYS.caFingerprint);
  if (existing && normalizeFingerprint(existing) !== expected)
    throw new LegacyImportError('legacy_ca_conflict', 409);
  if (!readApprovedCa()) {
    approveCaCertificate({
      certificate: bytes.toString('utf8'),
      expected_fingerprint: expected,
      confirm: true,
    });
  }
}

export async function approveLegacyCutover(actor: string, confirmed: unknown) {
  return verifySetup(actor, confirmed, false);
}

export async function activateQrCloudSetup(actor: string, confirmed: unknown) {
  return verifySetup(actor, confirmed, true);
}

async function verifySetup(actor: string, confirmed: unknown, activate: boolean) {
  const state = targetState();
  const { cutoverPending, enabled, mode } = state.config;
  if (enabled || mode !== 'integrated' || (!activate && !cutoverPending))
    throw new LegacyImportError('legacy_cutover_not_pending', 409);
  if (cutoverPending && confirmed !== true) throw new LegacyImportError('confirmation_required');
  const test = await testQrCloudConnection();
  if (!test.ok) return test;
  if (JSON.stringify(targetState()) !== JSON.stringify(state))
    throw new LegacyImportError('legacy_preview_stale', 409);
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
    if (activate) updateConfig({ enabled: true });
  })();
  if (activate) startQrCloudConnector({ force: true });
  return test;
}
