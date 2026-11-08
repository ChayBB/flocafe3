import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSettingValue, upsertSettings } from '../../db';
import { QR_CLOUD_SETTING_KEYS } from './config';
import { inboxDirectory } from './inbox';

/**
 * TLS trust for the Cloud endpoint only.
 *
 * An approved public CA certificate is parsed, shown to an administrator, confirmed against an
 * independently trusted fingerprint, and stored in an application-managed directory. It is used
 * as the `ca` for requests to the configured Cloud origin and nothing else. The Windows trusted
 * root store is never modified, certificate validation is never disabled, and private keys are
 * never accepted.
 */

export const MAX_CERTIFICATE_BYTES = 64 * 1024;

export class CaCertificateError extends Error {
  constructor(public code: CaCertificateErrorCode) {
    super(code);
  }
}

export type CaCertificateErrorCode =
  | 'certificate_invalid'
  | 'certificate_too_large'
  | 'certificate_not_ca'
  | 'certificate_expired'
  | 'certificate_private_key_rejected'
  | 'fingerprint_invalid'
  | 'fingerprint_mismatch'
  | 'confirmation_required';

export interface CaCertificateInfo {
  subject: string;
  issuer: string;
  valid_from: string;
  valid_to: string;
  fingerprint_sha256: string;
  is_ca: boolean;
  pem: string;
}

/** `aa:bb:…` uppercase with colons, from either PEM/DER bytes or a typed fingerprint. */
export function normalizeFingerprint(value: unknown): string {
  if (typeof value !== 'string') throw new CaCertificateError('fingerprint_invalid');
  const compact = value.replace(/[:\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(compact)) throw new CaCertificateError('fingerprint_invalid');
  return compact.match(/.{2}/g)!.join(':');
}

export function caDirectory(): string {
  return path.join(inboxDirectory(), 'ca');
}

export function caFilePath(): string {
  return path.join(caDirectory(), 'approved-ca.pem');
}

function toDer(input: Buffer | string): Buffer {
  if (Buffer.isBuffer(input)) {
    if (input.includes('-----BEGIN')) return toDer(input.toString('utf8'));
    return input;
  }
  if (
    input.includes('BEGIN PRIVATE KEY') ||
    input.includes('BEGIN RSA PRIVATE KEY') ||
    input.includes('BEGIN EC PRIVATE KEY')
  )
    throw new CaCertificateError('certificate_private_key_rejected');
  const match = input.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!match) throw new CaCertificateError('certificate_invalid');
  const body = match[0].replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  try {
    return Buffer.from(body, 'base64');
  } catch {
    throw new CaCertificateError('certificate_invalid');
  }
}

/** Parses and structurally validates a CA certificate without trusting it. */
export function inspectCaCertificate(input: Buffer | string): CaCertificateInfo {
  const der = toDer(input);
  if (der.length === 0) throw new CaCertificateError('certificate_invalid');
  if (der.length > MAX_CERTIFICATE_BYTES) throw new CaCertificateError('certificate_too_large');
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(der);
  } catch {
    throw new CaCertificateError('certificate_invalid');
  }
  const notAfter = new Date(cert.validTo).getTime();
  if (!Number.isFinite(notAfter) || notAfter <= Date.now())
    throw new CaCertificateError('certificate_expired');
  const isCa = (cert as unknown as { ca?: boolean }).ca === true;
  if (!isCa) throw new CaCertificateError('certificate_not_ca');
  const fingerprint = normalizeFingerprint(cert.fingerprint256);
  const pem = cert.toString();
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    valid_from: new Date(cert.validFrom).toISOString(),
    valid_to: new Date(cert.validTo).toISOString(),
    fingerprint_sha256: fingerprint,
    is_ca: true,
    pem,
  };
}

export interface ApproveCaRequest {
  certificate: string;
  expected_fingerprint: string;
  confirm: boolean;
}

/**
 * Stores the certificate as the Cloud connector's only extra trust anchor.
 * `expected_fingerprint` must match the certificate: the administrator is confirming a value
 * obtained over a trusted channel, not trusting whatever was uploaded.
 */
export function approveCaCertificate(request: ApproveCaRequest): CaCertificateInfo {
  if (request.confirm !== true) throw new CaCertificateError('confirmation_required');
  const info = inspectCaCertificate(request.certificate);
  const expected = normalizeFingerprint(request.expected_fingerprint);
  if (expected !== info.fingerprint_sha256) throw new CaCertificateError('fingerprint_mismatch');

  fs.mkdirSync(caDirectory(), { recursive: true, mode: 0o700 });
  const target = caFilePath();
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, info.pem, { mode: 0o600 });
  // Windows refuses a rename over an existing file, so replace the previous anchor explicitly.
  fs.rmSync(target, { force: true });
  fs.renameSync(temp, target);
  upsertSettings({
    [QR_CLOUD_SETTING_KEYS.caFingerprint]: info.fingerprint_sha256,
    [QR_CLOUD_SETTING_KEYS.caSubject]: info.subject,
    [QR_CLOUD_SETTING_KEYS.caNotAfter]: info.valid_to,
  });
  return info;
}

/** The approved CA, or null when none is configured or the stored file no longer matches. */
export function readApprovedCa(): {
  pem: string;
  fingerprint_sha256: string;
  subject: string;
} | null {
  const expected = getSettingValue(QR_CLOUD_SETTING_KEYS.caFingerprint) || '';
  if (!expected) return null;
  let pem: string;
  try {
    pem = fs.readFileSync(caFilePath(), 'utf8');
  } catch {
    return null;
  }
  let info: CaCertificateInfo;
  try {
    info = inspectCaCertificate(pem);
  } catch {
    return null;
  }
  if (info.fingerprint_sha256 !== normalizeFingerprint(expected)) return null;
  return { pem, fingerprint_sha256: info.fingerprint_sha256, subject: info.subject };
}

export function caStatus() {
  const stored = readApprovedCa();
  const expected = getSettingValue(QR_CLOUD_SETTING_KEYS.caFingerprint) || '';
  return {
    configured: Boolean(stored),
    fingerprint_sha256:
      stored?.fingerprint_sha256 ?? (expected ? normalizeFingerprint(expected) : null),
    subject: getSettingValue(QR_CLOUD_SETTING_KEYS.caSubject) || null,
    not_after: getSettingValue(QR_CLOUD_SETTING_KEYS.caNotAfter) || null,
    // A stored fingerprint whose file is missing or altered is reported, not silently trusted.
    file_verified: Boolean(stored),
  };
}

export function removeApprovedCa(): void {
  try {
    fs.rmSync(caFilePath(), { force: true });
  } catch {
    // Nothing to remove is success.
  }
  upsertSettings({
    [QR_CLOUD_SETTING_KEYS.caFingerprint]: '',
    [QR_CLOUD_SETTING_KEYS.caSubject]: '',
    [QR_CLOUD_SETTING_KEYS.caNotAfter]: '',
  });
}
