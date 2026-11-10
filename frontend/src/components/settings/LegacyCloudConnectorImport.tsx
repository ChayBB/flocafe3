'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

interface LegacyPreview {
  source_found: boolean;
  cloud_url: string | null;
  connector_token_present: boolean | null;
  poll_interval_ms: number | null;
  ca_certificate_found: boolean;
  ca_certificate: {
    subject: string;
    issuer: string;
    valid_from: string;
    valid_to: string;
    fingerprint_sha256: string;
    is_ca: boolean;
    basic_constraints: { critical: boolean; path_length: string | null } | null;
  } | null;
  ca_error: string | null;
  ca_matches_expected: boolean;
  conflicts: ('configuration' | 'credential' | 'certificate')[];
  validation_errors: string[];
  ready_for_import: boolean;
  preview_id: string | null;
}

const ERROR_LABEL = {
  legacy_unsafe_file: 'qcLegacyUnsafe',
  legacy_file_too_large: 'qcLegacyUnsafe',
  legacy_file_unreadable: 'qcLegacyUnsafe',
  legacy_env_invalid: 'qcLegacyMalformed',
  legacy_windows_only: 'qcLegacyWindows',
  legacy_loopback_required: 'qcLegacyWindows',
  legacy_source_changed: 'qcLegacyStale',
  legacy_preview_stale: 'qcLegacyStale',
  legacy_replace_credential_required: 'qcLegacyReplaceToken',
  legacy_ca_requires_staging_import: 'qcLegacyCaRequiresImport',
  legacy_ca_missing: 'qcLegacyCaMissing',
  legacy_ca_conflict: 'qcLegacyCaConflict',
  legacy_cutover_not_pending: 'qcLegacyStale',
  authentication_required: 'qcLegacyPermission',
  permission_denied: 'qcLegacyPermission',
  confirmation_required: 'qcCaError_confirmation_required',
  fingerprint_invalid: 'qcCaError_fingerprint_invalid',
  fingerprint_mismatch: 'qcCaError_fingerprint_mismatch',
  certificate_invalid: 'qcCaError_certificate_invalid',
  certificate_not_ca: 'qcCaError_certificate_not_ca',
  certificate_expired: 'qcCaError_certificate_expired',
  certificate_too_large: 'qcCaError_certificate_too_large',
  cloud_url_invalid: 'qcErrorUrlInvalid',
  cloud_url_not_https: 'qcErrorUrlNotHttps',
  cloud_url_private_target: 'qcErrorUrlPrivate',
  poll_interval_invalid: 'qcErrorInterval',
  token_invalid: 'qcLegacyTokenInvalid',
  credential_storage_unavailable: 'qcStorageUnavailable',
  not_configured: 'qcErrorNotConfigured',
  auth_failed: 'qcErrorAuth',
  tls_failed: 'qcErrorTls',
  offline: 'qcErrorOffline',
  timeout: 'qcErrorTimeout',
  server_error: 'qcErrorServer',
  bad_response: 'qcErrorResponse',
  blocked_target: 'qcErrorBlocked',
} as const;

const CONFLICT_LABEL = {
  configuration: 'qcLegacyConfigConflict',
  credential: 'qcLegacyCredentialConflict',
  certificate: 'qcLegacyCaConflict',
} as const;

const endpoint = '/qr-cloud/legacy-import';

export function LegacyCloudConnectorImport({
  cutoverPending,
  autoInspect,
  trustedFingerprint,
  onUpdated,
}: {
  cutoverPending: boolean;
  autoInspect: boolean;
  trustedFingerprint?: string | null;
  onUpdated: () => Promise<void>;
}) {
  const t = useTranslations('settings');
  const [preview, setPreview] = useState<LegacyPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [replace, setReplace] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [confirmCa, setConfirmCa] = useState(false);
  const [busy, setBusy] = useState(autoInspect);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!autoInspect) return;
    let active = true;
    void api
      .post<LegacyPreview>(`${endpoint}/preview`)
      .then(({ data }) => {
        if (active) setPreview(data);
      })
      .catch((error: unknown) => {
        const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
        if (active)
          setMessage({
            text: t(ERROR_LABEL[code as keyof typeof ERROR_LABEL] ?? 'qcLegacyFailed'),
            error: true,
          });
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [autoInspect, t]);

  const errorMessage = (code: string | undefined | null) =>
    t(ERROR_LABEL[code as keyof typeof ERROR_LABEL] ?? 'qcLegacyFailed');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'legacy_preview_stale') setPreview(null);
      setMessage({ text: errorMessage(code), error: true });
    } finally {
      setBusy(false);
    }
  }

  function inspect() {
    void run(async () => {
      setPreview(null);
      setConfirm(false);
      setReplace(false);
      setFingerprint('');
      setConfirmCa(false);
      const { data } = await api.post<LegacyPreview>(`${endpoint}/preview`);
      setPreview(data);
    });
  }

  function commit() {
    void run(async () => {
      const approveCa = needsLegacyCa && confirmCa && fingerprint.trim();
      const { data } = await api.post<{ imported: boolean }>(`${endpoint}/commit`, {
        preview_id: preview?.preview_id,
        confirm,
        replace_credential: replace,
      });
      if (data?.imported !== true) throw new Error('Missing import receipt');
      setConfirm(false);
      setReplace(false);
      setPreview((current) => current && { ...current, ready_for_import: false, conflicts: [] });
      await onUpdated();
      if (approveCa) await saveLegacyCertificate();
      setMessage({
        text: t(approveCa ? 'qcSetupImportedAndTrusted' : 'qcLegacyImported'),
        error: false,
      });
    });
  }

  async function saveLegacyCertificate() {
    const { data } = await api.post<{ configured: boolean }>(`${endpoint}/ca`, {
      expected_fingerprint: fingerprint,
      confirm: confirmCa,
    });
    if (data?.configured !== true) throw new Error('Missing certificate approval receipt');
    setFingerprint('');
    setConfirmCa(false);
    await onUpdated();
  }

  function importCertificate() {
    void run(async () => {
      await saveLegacyCertificate();
      setMessage({ text: t('qcLegacyCaImported'), error: false });
    });
  }

  const certificate = preview?.ca_certificate;
  const credentialConflict = preview?.conflicts.includes('credential') ?? false;
  const needsLegacyCa = Boolean(
    preview?.ca_matches_expected && certificate?.fingerprint_sha256 !== trustedFingerprint,
  );
  const importingConfig = Boolean(preview?.ready_for_import && !cutoverPending);

  return (
    <section
      aria-labelledby="qc-legacy-import-title"
      className="space-y-3 rounded-md border border-border p-3 text-sm"
    >
      <h3 id="qc-legacy-import-title" className="font-medium">
        {t('qcLegacyTitle')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('qcLegacyHint')}</p>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={inspect}>
        {t('qcLegacyInspect')}
      </Button>
      {busy && <p role="status">{t('qcLegacyWorking')}</p>}

      {preview && (
        <div className="space-y-2">
          <p>{t(preview.source_found ? 'qcLegacyFound' : 'qcLegacyMissing')}</p>
          {preview.source_found && (
            <dl className="grid grid-cols-[auto_1fr] gap-2 break-all text-xs">
              <dt>{t('qcUrl')}</dt>
              <dd>{preview.cloud_url ?? t('qcNone')}</dd>
              <dt>{t('qcToken')}</dt>
              <dd>
                {t(
                  preview.connector_token_present === null
                    ? 'qcUnchecked'
                    : preview.connector_token_present
                      ? 'qcLegacyTokenPresent'
                      : 'qcLegacyTokenMissing',
                )}
              </dd>
              <dt>{t('qcLegacyInterval')}</dt>
              <dd>
                {preview.poll_interval_ms === null ? t('qcNone') : preview.poll_interval_ms / 1000}
              </dd>
            </dl>
          )}
          {preview.ca_certificate_found && <p>{t('qcLegacyCaFound')}</p>}
          {certificate ? (
            <div className="space-y-1">
              <p className="break-all text-xs">
                {t('qcLegacyCaFingerprint')}{' '}
                <span className="font-mono">{certificate.fingerprint_sha256}</span>
              </p>
              <details>
                <summary className="cursor-pointer">{t('qcLegacyInspectCa')}</summary>
                <dl className="grid grid-cols-[auto_1fr] gap-2 break-all text-xs">
                  <dt>{t('qcLegacyCaSubject')}</dt>
                  <dd>{certificate.subject}</dd>
                  <dt>{t('qcLegacyCaIssuer')}</dt>
                  <dd>{certificate.issuer}</dd>
                  <dt>{t('qcLegacyCaValidity')}</dt>
                  <dd>
                    {certificate.valid_from} / {certificate.valid_to}
                  </dd>
                  <dt>{t('qcLegacyCaConstraint')}</dt>
                  <dd>
                    {t(certificate.is_ca ? 'qcLegacyCaTrue' : 'qcCaError_certificate_not_ca')}
                  </dd>
                  {certificate.basic_constraints && (
                    <>
                      <dt>{t('qcLegacyCaCritical')}</dt>
                      <dd>
                        {t(certificate.basic_constraints.critical ? 'qcLegacyYes' : 'qcLegacyNo')}
                      </dd>
                      <dt>{t('qcLegacyCaPathLength')}</dt>
                      <dd>{certificate.basic_constraints.path_length ?? t('qcNone')}</dd>
                    </>
                  )}
                </dl>
              </details>
              {!preview.ca_matches_expected && <p>{t('qcCaError_fingerprint_mismatch')}</p>}
            </div>
          ) : (
            <p>{preview.ca_error ? errorMessage(preview.ca_error) : t('qcLegacyCaMissing')}</p>
          )}
          {preview.validation_errors.length > 0 && (
            <ul role="alert" className="list-disc space-y-1 ps-5">
              {preview.validation_errors.map((code) => (
                <li key={code}>{errorMessage(code)}</li>
              ))}
            </ul>
          )}
          {preview.conflicts.length > 0 && (
            <ul className="list-disc space-y-1 ps-5" role="status">
              {preview.conflicts.map((conflict) => (
                <li key={conflict}>{t(CONFLICT_LABEL[conflict])}</li>
              ))}
            </ul>
          )}
          {(importingConfig || cutoverPending) && needsLegacyCa && (
            <fieldset disabled={busy} className="space-y-2">
              <label className="block">
                {t('qcLegacyCaIndependent')}
                <input
                  className="mt-1 block w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
                  value={fingerprint}
                  maxLength={128}
                  onChange={(e) => setFingerprint(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirmCa}
                  onChange={(e) => setConfirmCa(e.target.checked)}
                />
                {t('qcLegacyCaConfirm')}
              </label>
              {cutoverPending && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!fingerprint.trim() || !confirmCa}
                  onClick={importCertificate}
                >
                  {t('qcLegacyCaApprove')}
                </Button>
              )}
            </fieldset>
          )}
          {importingConfig && (
            <fieldset disabled={busy} className="space-y-2">
              <legend className="font-medium">{t('qcLegacyConfirmTitle')}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                {t('qcLegacyConfirm')}
              </label>
              {credentialConflict && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  {t('qcLegacyReplaceToken')}
                </label>
              )}
              <Button
                type="button"
                size="sm"
                disabled={
                  !confirm || (credentialConflict && !replace) || (confirmCa && !fingerprint.trim())
                }
                onClick={commit}
              >
                {t('qcLegacyCommit')}
              </Button>
            </fieldset>
          )}
        </div>
      )}

      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </section>
  );
}
