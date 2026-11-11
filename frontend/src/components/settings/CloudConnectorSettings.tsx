'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { GuestQrNetworkSettings } from '@/components/settings/GuestQrNetworkSettings';
import { LegacyCloudConnectorImport } from '@/components/settings/LegacyCloudConnectorImport';
import { CloudInboxOrders } from '@/components/settings/CloudInboxOrders';
import { CloudTableQr } from '@/components/settings/CloudTableQr';
import { CloudCatalogPublish } from '@/components/settings/CloudCatalogPublish';
import { CloudGuestScroll } from './CloudGuestScroll';
import { downloadBlob } from '@/lib/download';

/**
 * Cloud QR Ordering: the integrated Cloud Connector, with the legacy QR Relay kept as a mode.
 *
 * The connector token is write-only from the browser: it can be replaced or removed, never read.
 * TLS trust is an explicit administrator action: inspect, compare a fingerprint obtained over a
 * trusted channel, then approve.
 */

type ConnectorState =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'CONNECTING'
  | 'CONNECTED_POLLING'
  | 'CONNECTED_WEBSOCKET'
  | 'DEGRADED'
  | 'AUTH_FAILED'
  | 'TLS_FAILED'
  | 'OFFLINE'
  | 'STOPPING';

interface ConnectorConfig {
  enabled: boolean;
  mode: 'legacy_relay' | 'integrated';
  cloud_url: string;
  connection_mode: 'auto' | 'polling';
  poll_interval_ms: number;
  auto_start: boolean;
  retry_max: number;
  timeout_ms: number;
  reconcile_interval_ms: number;
  has_token: boolean;
  cutover_pending: boolean;
  acceptance_mode?: 'manual' | 'automatic';
}

interface ConnectorStatus {
  state: ConnectorState;
  authentication: 'unchecked' | 'accepted' | 'rejected';
  last_poll_at: string | null;
  last_duplicate_count: number | null;
  receipts?: { pending: number; retrying: number; acknowledged: number } | null;
  branch_identity: { tenant: string | null; branch: string | null };
  last_success_at: string | null;
  last_error: { at: string; code: string; detail: string | null } | null;
  inbox: {
    available: boolean;
    received: number;
    processing: number;
    applied: number;
    failed: number;
    total: number;
  };
  tls: {
    configured: boolean;
    fingerprint_sha256: string | null;
    subject: string | null;
    not_after: string | null;
  };
  websocket: { available: boolean; reason: string };
}

interface Diagnostics {
  state: ConnectorState;
  error_history: Array<{ at: string; code: string; detail: string | null }>;
  recent_polls: Array<{
    checked_at: string;
    event_count: number;
    result: string;
    detail: string | null;
  }>;
  inbox: ConnectorStatus['inbox'];
  polling: {
    poll_interval_ms: number;
    timeout_ms: number;
    retry_max: number;
    reconcile_interval_ms: number;
  };
}

const STATE_LABEL = {
  DISABLED: 'qcStateDisabled',
  NOT_CONFIGURED: 'qcStateNotConfigured',
  CONNECTING: 'qcStateConnecting',
  CONNECTED_POLLING: 'qcStatePolling',
  CONNECTED_WEBSOCKET: 'qcStateWebsocket',
  DEGRADED: 'qcStateDegraded',
  AUTH_FAILED: 'qcStateAuthFailed',
  TLS_FAILED: 'qcStateTlsFailed',
  OFFLINE: 'qcStateOffline',
  STOPPING: 'qcStateStopping',
} as const satisfies Record<ConnectorState, string>;

const TEST_ERROR_KEYS = {
  not_configured: 'qcErrorNotConfigured',
  auth_failed: 'qcErrorAuth',
  tls_failed: 'qcErrorTls',
  offline: 'qcErrorOffline',
  timeout: 'qcErrorTimeout',
  server_error: 'qcErrorServer',
  bad_response: 'qcErrorResponse',
  blocked_target: 'qcErrorBlocked',
} as const;

const AUTH_LABEL = {
  unchecked: 'qcUnchecked',
  accepted: 'qcAuthAccepted',
  rejected: 'qcStateAuthFailed',
} as const;

const POLL_INTERVALS = [5, 10, 15, 30, 60, 120, 300];

const SETTING_ERROR_KEYS = {
  cloud_url_invalid: 'qcErrorUrlInvalid',
  cloud_url_not_https: 'qcErrorUrlNotHttps',
  cloud_url_private_target: 'qcErrorUrlPrivate',
  poll_interval_invalid: 'qcErrorInterval',
  timeout_invalid: 'qcErrorTimeoutSetting',
  retry_invalid: 'qcErrorRetrySetting',
  reconcile_invalid: 'qcErrorInterval',
  mode_invalid: 'qcErrorSave',
  connection_mode_invalid: 'qcErrorSave',
  cutover_required: 'qcLegacyCutoverPending',
  automatic_delivery_unavailable: 'qcAcceptanceUnavailable',
} as const;

const SETUP_ERROR_KEYS = {
  ...TEST_ERROR_KEYS,
  ...SETTING_ERROR_KEYS,
  confirmation_required: 'qcCaError_confirmation_required',
  legacy_preview_stale: 'qcLegacyStale',
  legacy_loopback_required: 'qcLegacyWindows',
} as const;

const CA_ERROR_KEYS = {
  certificate_invalid: 'qcCaError_certificate_invalid',
  certificate_not_ca: 'qcCaError_certificate_not_ca',
  certificate_expired: 'qcCaError_certificate_expired',
  certificate_too_large: 'qcCaError_certificate_too_large',
  certificate_private_key_rejected: 'qcCaError_certificate_private_key_rejected',
  fingerprint_invalid: 'qcCaError_fingerprint_invalid',
  fingerprint_mismatch: 'qcCaError_fingerprint_mismatch',
  confirmation_required: 'qcCaError_confirmation_required',
} as const;

function errorCode(error: unknown): string {
  const response = (error as { response?: { data?: { code?: unknown } } } | undefined)?.response;
  const code = response?.data?.code;
  return typeof code === 'string' ? code : '';
}

function messageFor<T extends Record<string, string>>(
  map: T,
  code: string | null | undefined,
  fallback: T[keyof T],
): T[keyof T] {
  return code && code in map ? map[code as keyof T] : fallback;
}

function stateTone(state: ConnectorState): string {
  if (state === 'CONNECTED_POLLING')
    return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
  if (state === 'CONNECTING') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  if (state === 'DISABLED' || state === 'NOT_CONFIGURED') return 'bg-muted text-muted-foreground';
  return 'bg-red-500/15 text-red-600 dark:text-red-400';
}

export function CloudConnectorSettings({
  guestQrEnabled,
  canManage,
}: {
  guestQrEnabled: boolean;
  canManage: boolean;
}) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [config, setConfig] = useState<ConnectorConfig | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [intervalDraft, setIntervalDraft] = useState('15');
  const [customInterval, setCustomInterval] = useState(false);
  const [testing, setTesting] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [startingSetup, setStartingSetup] = useState(false);
  const [legacyStopped, setLegacyStopped] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; code: string | null } | null>(null);
  const [certDraft, setCertDraft] = useState<{
    pem: string;
    subject: string;
    issuer: string;
    valid_from: string;
    valid_to: string;
    fingerprint: string;
  } | null>(null);
  const [fingerprintDraft, setFingerprintDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const statusVersion = useRef(0);
  const [acceptanceSaving, setAcceptanceSaving] = useState(false);

  const apply = useCallback((payload: { config?: ConnectorConfig; status?: ConnectorStatus }) => {
    statusVersion.current += 1;
    if (payload.config) {
      setConfig(payload.config);
      setUrlDraft(payload.config.cloud_url);
      const interval = payload.config.poll_interval_ms / 1000;
      setIntervalDraft(String(interval));
      setCustomInterval(!POLL_INTERVALS.includes(interval));
    }
    if (payload.status) setStatus(payload.status);
  }, []);

  const refresh = useCallback(async () => {
    const version = statusVersion.current;
    try {
      const { data } = await api.get('/qr-cloud');
      if (version === statusVersion.current) setStatus(data.status);
    } catch {
      // A connector that is not reachable must not break the settings page.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const version = statusVersion.current;
      try {
        const { data } = await api.get('/qr-cloud');
        if (!data?.config || !data?.status) throw new Error('Invalid Cloud Connector response');
        if (!cancelled && version === statusVersion.current) {
          setLoadFailed(false);
          if (version === 0) apply(data);
          else setStatus(data.status);
        }
      } catch {
        if (!cancelled && version === statusVersion.current) setLoadFailed(true);
      }
      if (!cancelled) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apply]);

  const save = async (patch: Record<string, unknown>, updateDrafts = false) => {
    try {
      const { data } = await api.put('/qr-cloud/settings', patch);
      statusVersion.current += 1;
      setConfig(data.config);
      setStatus(data.status);
      setTestResult(null);
      if (updateDrafts && 'cloud_url' in patch) setUrlDraft(data.config.cloud_url);
      if (updateDrafts && 'poll_interval_ms' in patch)
        setIntervalDraft(String(data.config.poll_interval_ms / 1000));
      toast.success(t('qcSaved'));
      return true;
    } catch (error: unknown) {
      toast.error(t(messageFor(SETTING_ERROR_KEYS, errorCode(error), 'qcErrorSave')));
      return false;
    }
  };

  const saveToken = async () => {
    const input = tokenRef.current;
    if (!input?.value.trim()) return;
    try {
      const { data } = await api.post('/qr-cloud/token', { token: input.value });
      input.value = '';
      statusVersion.current += 1;
      setConfig(
        (current) =>
          current && { ...current, has_token: data.has_token, acceptance_mode: 'manual' },
      );
      setStatus(data.status);
      setTestResult(null);
      toast.success(t('qcTokenSaved'));
    } catch (error: unknown) {
      toast.error(
        t(
          errorCode(error) === 'credential_storage_unavailable'
            ? 'qcStorageUnavailable'
            : 'qcErrorToken',
        ),
      );
    }
  };

  const clearToken = async () => {
    const ok = await confirm(t('qcTokenClearConfirm'), {
      title: t('qcTokenClear'),
      confirmLabel: t('qcTokenClear'),
      destructive: true,
    });
    if (!ok) return;
    try {
      const { data } = await api.delete('/qr-cloud/token');
      statusVersion.current += 1;
      setConfig(
        (current) =>
          current && { ...current, has_token: data.has_token, acceptance_mode: 'manual' },
      );
      setStatus(data.status);
      setTestResult(null);
      toast.success(t('qcTokenCleared'));
    } catch {
      toast.error(t('qcErrorToken'));
    }
  };

  const runTest = async () => {
    const version = statusVersion.current;
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post('/qr-cloud/test');
      if (version !== statusVersion.current) return;
      setTestResult({ ok: data.ok, code: data.code });
      toast[data.ok ? 'success' : 'error'](
        t(data.ok ? 'qcTestOk' : messageFor(TEST_ERROR_KEYS, data.code, 'qcErrorResponse')),
      );
      void refresh();
    } catch {
      setTestResult({ ok: false, code: 'offline' });
      toast.error(t('qcErrorOffline'));
    } finally {
      setTesting(false);
    }
  };

  const activateSetup = async () => {
    setActivating(true);
    setActivationError('');
    try {
      const { data } = await api.post('/qr-cloud/activate', {
        confirm_legacy_stopped: legacyStopped,
      });
      if (!data?.ok || !data.config?.enabled) {
        setActivationError(data?.code ?? 'bad_response');
        return;
      }
      apply(data);
      setLegacyStopped(false);
      setSetupOpen(false);
      toast.success(t('qcSetupStarted'));
    } catch (error) {
      setActivationError(errorCode(error) || 'offline');
    } finally {
      setActivating(false);
    }
  };

  const openSetup = async () => {
    setStartingSetup(true);
    try {
      if (
        !config?.cloud_url &&
        !urlDraft.trim() &&
        !(await save({ cloud_url: 'https://qr-staging.test' }, true))
      )
        return;
      setSetupOpen(true);
    } finally {
      setStartingSetup(false);
    }
  };

  const loadDiagnostics = async () => {
    try {
      const { data } = await api.get('/qr-cloud/diagnostics');
      setDiagnostics(data);
      setShowDiagnostics(true);
    } catch {
      toast.error(t('qcErrorDiagnostics'));
    }
  };

  const clearErrors = async () => {
    const ok = await confirm(t('qcClearErrorsConfirm'), {
      title: t('qcClearErrors'),
      confirmLabel: t('qcClearErrors'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete('/qr-cloud/diagnostics/errors');
      toast.success(t('qcErrorsCleared'));
      void loadDiagnostics();
    } catch {
      toast.error(t('qcErrorDiagnostics'));
    }
  };

  const readCertificate = async (file: File) => {
    setCertDraft(null);
    setFingerprintDraft('');
    try {
      const text = await file.text();
      const { data } = await api.post('/qr-cloud/ca/inspect', { certificate: text });
      setCertDraft({
        pem: text,
        subject: data.subject,
        issuer: data.issuer,
        valid_from: data.valid_from,
        valid_to: data.valid_to,
        fingerprint: data.fingerprint_sha256,
      });
    } catch (error: unknown) {
      toast.error(t(messageFor(CA_ERROR_KEYS, errorCode(error), 'qcCaError_certificate_invalid')));
    }
  };

  const approveCertificate = async () => {
    if (!certDraft) return;
    try {
      await api.post('/qr-cloud/ca', {
        certificate: certDraft.pem,
        expected_fingerprint: fingerprintDraft,
        confirm: true,
      });
      setCertDraft(null);
      setFingerprintDraft('');
      toast.success(t('qcCaApproved'));
      void refresh();
    } catch (error: unknown) {
      toast.error(t(messageFor(CA_ERROR_KEYS, errorCode(error), 'qcCaError_fingerprint_mismatch')));
    }
  };

  const removeCertificate = async () => {
    const ok = await confirm(t('qcCaRemoveConfirm'), {
      title: t('qcCaRemove'),
      confirmLabel: t('qcCaRemove'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete('/qr-cloud/ca');
      toast.success(t('qcCaRemoved'));
      void refresh();
    } catch {
      toast.error(t('qcErrorSave'));
    }
  };

  const mode = config?.mode ?? 'integrated';
  const showSetup = Boolean(
    config && (setupOpen || config.cutover_pending || mode === 'legacy_relay'),
  );
  const currentState = status?.state ?? 'DISABLED';

  const inboxSummary = status?.inbox;

  return (
    <section
      data-testid="settings-qr-cloud"
      aria-labelledby="cloud-qr-ordering-title"
      className="space-y-4 rounded-xl border border-border bg-card p-6"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 id="cloud-qr-ordering-title" className="font-semibold text-foreground">
          Cloud QR Ordering
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          FloCafe3
        </span>
      </header>
      <div className="flex items-start gap-2">
        <Cloud size={18} className="mt-0.5 text-brand" />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">Cloud QR SaaS</p>
          <p className="text-xs text-muted-foreground">{t('qcHint')}</p>
        </div>
        <span
          data-testid="qc-state"
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateTone(currentState)}`}
        >
          {status ? t(STATE_LABEL[currentState]) : t('qcUnchecked')}
        </span>
      </div>

      {loadFailed && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          {t('qcLocalApiUnavailable')}
        </p>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('qcMode')}>
        {(['integrated', 'legacy_relay'] as const).map((value) => (
          <button
            key={value}
            type="button"
            disabled={!canManage || !config}
            data-testid={`qc-mode-${value}`}
            onClick={() => void save({ mode: value })}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
              mode === value
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(value === 'integrated' ? 'qcModeIntegrated' : 'qcModeLegacy')}
          </button>
        ))}
      </div>

      {mode === 'integrated' && config && (
        <div className="space-y-3">
          {!config.enabled && <h4 className="text-sm font-semibold">{t('qcSetupStep1')}</h4>}
          {config.enabled ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                disabled={!canManage}
                data-testid="qc-enabled"
                checked={config.enabled}
                onChange={() => void save({ enabled: false })}
                className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
              />
              {t('qcEnable')}
            </label>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canManage || showSetup || startingSetup}
              data-testid="qc-setup-start"
              onClick={() => void openSetup()}
            >
              {t('qcEnable')}
              {!config.cloud_url && !urlDraft.trim() ? ' · https://qr-staging.test' : ''}
            </Button>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="block text-xs font-medium text-foreground">{t('qcUrl')}</span>
              <input
                type="url"
                disabled={!canManage}
                data-testid="qc-url"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://qr-staging.test"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-muted-foreground">{t('qcUrlHint')}</span>
            </label>
            <div className="flex items-end gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void save({ cloud_url: urlDraft }, true)}
                disabled={!canManage}
                data-testid="qc-save-url"
              >
                {t('qcSave')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {config && (showSetup || config.enabled) && (
        <section className="space-y-3">
          {!config.enabled && <h4 className="text-sm font-semibold">{t('qcSetupStep2')}</h4>}
          {canManage && (
            <LegacyCloudConnectorImport
              cutoverPending={config.cutover_pending}
              autoInspect={setupOpen}
              trustedFingerprint={status?.tls.configured ? status.tls.fingerprint_sha256 : null}
              onUpdated={async () => {
                setLegacyStopped(false);
                try {
                  const { data } = await api.get('/qr-cloud');
                  apply(data);
                } catch {
                  setLoadFailed(true);
                }
              }}
            />
          )}
          {mode === 'integrated' && (
            <details className="space-y-3 rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">{t('qcSetupManual')}</summary>
              <div className="rounded-md border border-border p-3">
                <p className="text-xs font-medium text-foreground">{t('qcToken')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('qcTokenHint')}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span
                    data-testid="qc-token-state"
                    className={`rounded px-2 py-0.5 text-xs ${
                      config.has_token
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {t(config.has_token ? 'qcTokenSet' : 'qcTokenMissing')}
                  </span>
                  <input
                    ref={tokenRef}
                    type="password"
                    disabled={!canManage}
                    data-testid="qc-token-input"
                    autoComplete="off"
                    placeholder={t('qcTokenPlaceholder')}
                    className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void saveToken()}
                    disabled={!canManage}
                    data-testid="qc-token-save"
                  >
                    {t('qcTokenSave')}
                  </Button>
                  {config.has_token && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void clearToken()}
                      disabled={!canManage}
                      data-testid="qc-token-clear"
                    >
                      {t('qcTokenClear')}
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('qcTokenProof')}</p>
              </div>

              <div className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className="text-brand" />
                  <p className="text-xs font-medium text-foreground">{t('qcCaTitle')}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t('qcCaHint')}</p>
                {status?.tls.configured ? (
                  <div className="mt-2 space-y-1 text-xs">
                    <p
                      data-testid="qc-ca-fingerprint"
                      className="break-all font-mono text-foreground"
                    >
                      {status.tls.fingerprint_sha256}
                    </p>
                    <p className="text-muted-foreground">{status.tls.subject}</p>
                    <p className="text-muted-foreground">
                      {t('qcCaNotAfter', { date: status.tls.not_after ?? '-' })}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void removeCertificate()}
                      disabled={!canManage}
                    >
                      <Trash2 size={14} className="me-1" />
                      {t('qcCaRemove')}
                    </Button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(status?.tls.fingerprint_sha256 ? 'qcCaFileUnverified' : 'qcCaNone')}
                  </p>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  disabled={!canManage}
                  accept=".crt,.pem,.cer"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void readCertificate(file);
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => fileRef.current?.click()}
                  disabled={!canManage}
                  data-testid="qc-ca-import"
                >
                  <Upload size={14} className="me-1" />
                  {t('qcCaImport')}
                </Button>
                {certDraft && (
                  <div
                    className="mt-2 space-y-2 rounded border border-border p-2 text-xs"
                    data-testid="qc-ca-preview"
                  >
                    <p className="font-medium text-foreground">{certDraft.subject}</p>
                    <p className="text-muted-foreground">
                      {t('qcCaIssuer', { issuer: certDraft.issuer })}
                    </p>
                    <p className="text-muted-foreground">
                      {t('qcCaValidity', { from: certDraft.valid_from, to: certDraft.valid_to })}
                    </p>
                    <p className="break-all font-mono text-foreground">{certDraft.fingerprint}</p>
                    <label className="block">
                      <span className="block text-muted-foreground">
                        {t('qcCaFingerprintLabel')}
                      </span>
                      <input
                        disabled={!canManage}
                        value={fingerprintDraft}
                        onChange={(e) => setFingerprintDraft(e.target.value)}
                        placeholder={certDraft.fingerprint}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                        data-testid="qc-ca-fingerprint-input"
                      />
                    </label>
                    <p className="text-muted-foreground">{t('qcCaFingerprintHint')}</p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void approveCertificate()}
                      disabled={!canManage}
                      data-testid="qc-ca-approve"
                    >
                      {t('qcCaApprove')}
                    </Button>
                  </div>
                )}
              </div>
            </details>
          )}
        </section>
      )}

      {canManage && config && showSetup && mode === 'integrated' && !config.enabled && (
        <section className="space-y-2 rounded-md border border-border p-3 text-sm">
          <h4 className="font-semibold">{t('qcSetupStep3')}</h4>
          {config.cutover_pending && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={legacyStopped}
                disabled={activating}
                onChange={(e) => setLegacyStopped(e.target.checked)}
              />
              {t('qcLegacyStopped')}
            </label>
          )}
          {!config.has_token && <p className="text-xs">{t('qcSetupNeedsToken')}</p>}
          {(!config.cloud_url || urlDraft.trim() !== config.cloud_url) && (
            <p className="text-xs">{t('qcSetupNeedsUrl')}</p>
          )}
          <Button
            type="button"
            size="sm"
            data-testid="qc-setup-activate"
            disabled={
              activating ||
              !config.has_token ||
              !config.cloud_url ||
              urlDraft.trim() !== config.cloud_url ||
              (config.cutover_pending && !legacyStopped)
            }
            onClick={() => void activateSetup()}
          >
            {t(activating ? 'qcTesting' : 'qcSetupActivate')}
          </Button>
          {activationError && (
            <p role="alert">
              {t(
                SETUP_ERROR_KEYS[activationError as keyof typeof SETUP_ERROR_KEYS] ??
                  'qcSetupFailed',
              )}
            </p>
          )}
        </section>
      )}

      {mode === 'integrated' && config && (
        <div className="space-y-3">
          <fieldset disabled={!canManage} className="space-y-1 text-sm">
            <legend className="text-xs font-medium">{t('qcConnectionMode')}</legend>
            {(['auto', 'polling'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="qr-cloud-connection-mode"
                  checked={config.connection_mode === value}
                  onChange={() => void save({ connection_mode: value })}
                />
                {t(value === 'auto' ? 'qcConnectionAuto' : 'qcConnectionPolling')}
              </label>
            ))}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs font-medium text-foreground">{t('qcInterval')}</span>
              <select
                disabled={!canManage}
                data-testid="qc-interval"
                value={customInterval ? 'custom' : String(config.poll_interval_ms / 1000)}
                onChange={async (e) => {
                  const value = e.target.value;
                  if (value === 'custom') setCustomInterval(true);
                  else if (await save({ poll_interval_ms: Number(value) * 1000 }, true))
                    setCustomInterval(false);
                }}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {POLL_INTERVALS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {t(seconds === 15 ? 'qcIntervalDefault' : 'qcIntervalSeconds', { seconds })}
                  </option>
                ))}
                <option value="custom">{t('qcIntervalCustom')}</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-6 text-sm text-foreground">
              <input
                type="checkbox"
                disabled={!canManage}
                checked={config.auto_start}
                onChange={(e) => void save({ auto_start: e.target.checked })}
                className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
              />
              {t('qcAutoStart')}
            </label>
          </div>
          {customInterval && (
            <label className="block text-xs">
              {t('qcIntervalHint')}
              <input
                type="number"
                disabled={!canManage}
                min={5}
                max={300}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                onBlur={() => {
                  const interval = Number(intervalDraft) * 1000;
                  if (interval !== config.poll_interval_ms)
                    void save({ poll_interval_ms: interval }, true);
                }}
                className="ms-2 w-24 rounded border border-border bg-background px-2 py-1"
              />
            </label>
          )}

          {config.enabled && canManage && (
            <label className="block space-y-1 rounded-md border border-border p-3 text-sm">
              <span className="block font-medium">{t('qcAcceptanceMode')}</span>
              <select
                className="rounded border border-border bg-background p-1"
                disabled={acceptanceSaving}
                value={config.acceptance_mode ?? 'manual'}
                onChange={async (event) => {
                  const mode = event.currentTarget.value;
                  setAcceptanceSaving(true);
                  try {
                    if (mode === 'automatic' && !(await confirm(t('qcAcceptanceConfirm')))) return;
                    await save({ acceptance_mode: mode, confirm_automatic: mode === 'automatic' });
                  } finally {
                    setAcceptanceSaving(false);
                  }
                }}
              >
                <option value="manual">{t('qcAcceptanceManual')}</option>
                <option value="automatic">{t('qcAcceptanceAutomatic')}</option>
              </select>
              <span className="block text-xs text-muted-foreground">{t('qcAcceptanceHint')}</span>
            </label>
          )}
          {canManage && <CloudTableQr key={`table-qr:${config.cloud_url}`} />}
          {config.enabled && canManage && (
            <CloudCatalogPublish key={`catalog:${config.cloud_url}`} />
          )}
          {config.enabled && canManage && <CloudGuestScroll key={`scroll:${config.cloud_url}`} />}
          {config.enabled && canManage && <CloudInboxOrders key={`inbox:${config.cloud_url}`} />}

          <section className="space-y-2 rounded-md border border-border p-3 text-sm">
            <h3 className="font-medium">{t('qcConnectionStatus')}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs [&>dd]:text-end [&>dt]:text-muted-foreground">
              <dt>{t('qcConnectorStatus')}</dt>
              <dd>{status ? t(STATE_LABEL[currentState]) : t('qcUnchecked')}</dd>
              <dt>{t('qcCloudAuth')}</dt>
              <dd data-testid="qc-cloud-auth">
                {t(AUTH_LABEL[status?.authentication ?? 'unchecked'])}
              </dd>
              <dt>{t('qcBranchIdentity')}</dt>
              <dd>
                {status?.branch_identity.tenant && status.branch_identity.branch
                  ? `${status.branch_identity.tenant} / ${status.branch_identity.branch}`
                  : t('qcIdentityUnavailable')}
              </dd>
              <dt>WebSocket</dt>
              <dd>{t('qcWssPending')}</dd>
              <dt>{t('qcInbox')}</dt>
              <dd>
                {inboxSummary?.available
                  ? t('qcInboxStatusCounts', {
                      pending: inboxSummary.received + inboxSummary.processing,
                      received: inboxSummary.total,
                      failed: inboxSummary.failed,
                    })
                  : t(inboxSummary ? 'qcInboxUnavailable' : 'qcUnchecked')}
              </dd>
              <dt>{t('qcLastDuplicates')}</dt>
              <dd>{status?.last_duplicate_count ?? t('qcNever')}</dd>
              {status?.receipts && (
                <>
                  <dt>{t('qcReceiptStatus')}</dt>
                  <dd>{t('qcReceiptCounts', status.receipts)}</dd>
                </>
              )}
              <dt>{t('qcLastPoll')}</dt>
              <dd>{status?.last_poll_at ?? t('qcNever')}</dd>
              <dt>{t('qcLastSync')}</dt>
              <dd>{status?.last_success_at ?? t('qcNever')}</dd>
              <dt>{t('qcLastOrderFetch')}</dt>
              <dd>{t('qcOrderFetchUnavailable')}</dd>
              <dt>{t('qcLastError')}</dt>
              <dd>{status?.last_error?.code ?? t('qcNone')}</dd>
            </dl>
          </section>

          {(!showSetup || config.enabled) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void runTest()}
                disabled={testing || !canManage}
                data-testid="qc-test"
              >
                <RefreshCw size={14} className="me-1" />
                {testing ? t('qcTesting') : t('qcTest')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  await api.post('/qr-cloud/retry');
                  void refresh();
                  toast.success(t('qcRetried'));
                }}
                disabled={!canManage}
              >
                {t('qcRetry')}
              </Button>
              {testResult && (
                <span
                  data-testid="qc-test-result"
                  className={`text-xs ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                >
                  {t(
                    testResult.ok
                      ? 'qcTestOk'
                      : messageFor(TEST_ERROR_KEYS, testResult.code, 'qcErrorResponse'),
                  )}
                </span>
              )}
            </div>
          )}

          <p className="rounded border border-dashed border-border p-2 text-xs text-muted-foreground">
            {t('qcWssUnavailable')}
          </p>

          <details className="rounded border border-border p-3 text-xs">
            <summary className="cursor-pointer font-medium">{t('qcAdvanced')}</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {(
                [
                  ['retry_max', 'qcRetryLimit', 1, 10, 1],
                  ['timeout_ms', 'qcTimeoutSeconds', 2, 60, 1000],
                  ['reconcile_interval_ms', 'qcReconcileSeconds', 30, 3600, 1000],
                ] as const
              ).map(([field, label, min, max, multiplier]) => (
                <label key={field}>
                  {t(label)}
                  <input
                    type="number"
                    disabled={!canManage}
                    min={min}
                    max={max}
                    defaultValue={config[field] / multiplier}
                    onBlur={(e) => {
                      const value = Number(e.currentTarget.value) * multiplier;
                      if (value !== config[field]) void save({ [field]: value });
                    }}
                    className="mt-1 block w-full rounded border border-border bg-background px-2 py-1"
                  />
                </label>
              ))}
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadDiagnostics()}
            >
              {t('qcDiagnostics')}
            </Button>
            {showDiagnostics && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowDiagnostics(false)}
              >
                {t('qcHideDiagnostics')}
              </Button>
            )}
          </div>

          {showDiagnostics && diagnostics && (
            <div
              className="space-y-2 rounded-md border border-border p-3 text-xs"
              data-testid="qc-diagnostics"
            >
              <p className="font-medium text-foreground">{t('qcRecentPolls')}</p>
              <ul className="space-y-1 text-muted-foreground">
                {diagnostics.recent_polls.length === 0 && <li>{t('qcNoPolls')}</li>}
                {diagnostics.recent_polls.slice(0, 5).map((poll, index) => (
                  <li key={`${poll.checked_at}-${index}`}>
                    {poll.checked_at} · {poll.result} · {poll.event_count}
                  </li>
                ))}
              </ul>
              <p className="font-medium text-foreground">{t('qcErrors')}</p>
              <ul className="space-y-1 text-muted-foreground">
                {diagnostics.error_history.length === 0 && <li>{t('qcNone')}</li>}
                {diagnostics.error_history.slice(-5).map((entry, index) => (
                  <li key={`${entry.at}-${index}`}>
                    {entry.at} · {entry.code}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canManage}
                onClick={() => void clearErrors()}
              >
                {t('qcClearErrors')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const safeDiagnostics = {
                    state: diagnostics.state,
                    polling: diagnostics.polling,
                    inbox: diagnostics.inbox,
                    error_history: diagnostics.error_history.map(({ at, code }) => ({ at, code })),
                    recent_polls: diagnostics.recent_polls.map(
                      ({ checked_at, event_count, result }) => ({
                        checked_at,
                        event_count,
                        result,
                      }),
                    ),
                  };
                  downloadBlob(
                    new Blob([JSON.stringify(safeDiagnostics, null, 2)], {
                      type: 'application/json',
                    }),
                    'flocafe-qr-cloud-diagnostics.json',
                  );
                }}
              >
                {t('qcExportDiagnostics')}
              </Button>
            </div>
          )}
        </div>
      )}

      <GuestQrNetworkSettings
        disabled={!guestQrEnabled}
        showRelayPairing={mode === 'legacy_relay'}
      />
      {ConfirmDialog}
    </section>
  );
}
