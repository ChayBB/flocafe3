'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import { GuestQrNetworkSettings } from '@/components/settings/GuestQrNetworkSettings';

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
}

interface ConnectorStatus {
  state: ConnectorState;
  last_success_at: string | null;
  last_error: { at: string; code: string; detail: string | null } | null;
  inbox: { received: number; processing: number; applied: number; failed: number; total: number };
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

export function CloudConnectorSettings({ guestQrEnabled }: { guestQrEnabled: boolean }) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [config, setConfig] = useState<ConnectorConfig | null>(null);
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [intervalDraft, setIntervalDraft] = useState('15');
  const [tokenDraft, setTokenDraft] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; code: string | null } | null>(null);
  const [certDraft, setCertDraft] = useState<{
    pem: string;
    subject: string;
    fingerprint: string;
  } | null>(null);
  const [fingerprintDraft, setFingerprintDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((payload: { config?: ConnectorConfig; status?: ConnectorStatus }) => {
    if (payload.config) {
      setConfig(payload.config);
      setUrlDraft(payload.config.cloud_url);
      setIntervalDraft(String(Math.round(payload.config.poll_interval_ms / 1000)));
    }
    if (payload.status) setStatus(payload.status);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/qr-cloud');
      apply(data);
    } catch {
      // A connector that is not reachable must not break the settings page.
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get('/qr-cloud')
        .then(({ data }) => {
          if (!cancelled) apply(data);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apply]);

  const save = async (patch: Record<string, unknown>) => {
    try {
      const { data } = await api.put('/qr-cloud/settings', patch);
      apply(data);
      toast.success(t('qcSaved'));
      return true;
    } catch (error: unknown) {
      toast.error(t(messageFor(SETTING_ERROR_KEYS, errorCode(error), 'qcErrorSave')));
      return false;
    }
  };

  const saveToken = async () => {
    if (!tokenDraft.trim()) return;
    try {
      const { data } = await api.post('/qr-cloud/token', { token: tokenDraft });
      setTokenDraft('');
      setStatus(data.status);
      toast.success(t('qcTokenSaved'));
    } catch {
      toast.error(t('qcErrorToken'));
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
      setStatus(data.status);
      toast.success(t('qcTokenCleared'));
    } catch {
      toast.error(t('qcErrorToken'));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post('/qr-cloud/test');
      setTestResult({ ok: data.ok, code: data.code });
      toast[data.ok ? 'success' : 'error'](
        t(data.ok ? 'qcTestOk' : messageFor(TEST_ERROR_KEYS, data.code, 'qcErrorResponse')),
      );
    } catch {
      setTestResult({ ok: false, code: 'offline' });
      toast.error(t('qcErrorOffline'));
    } finally {
      setTesting(false);
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
    const text = await file.text();
    try {
      const { data } = await api.post('/qr-cloud/ca/inspect', { certificate: text });
      setCertDraft({ pem: text, subject: data.subject, fingerprint: data.fingerprint_sha256 });
      setFingerprintDraft('');
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
  const currentState = status?.state ?? 'DISABLED';

  const inboxSummary = useMemo(() => status?.inbox, [status]);

  return (
    <div data-testid="settings-qr-cloud" className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start gap-2">
        <Cloud size={18} className="mt-0.5 text-brand" />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">{t('qcTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('qcHint')}</p>
        </div>
        <span
          data-testid="qc-state"
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateTone(currentState)}`}
        >
          {t(STATE_LABEL[currentState])}
        </span>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('qcMode')}>
        {(['integrated', 'legacy_relay'] as const).map((value) => (
          <button
            key={value}
            type="button"
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
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              data-testid="qc-enabled"
              checked={config.enabled}
              onChange={(e) => void save({ enabled: e.target.checked })}
              className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
            />
            {t('qcEnable')}
          </label>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="block text-xs font-medium text-foreground">{t('qcUrl')}</span>
              <input
                type="url"
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
                onClick={() => void save({ cloud_url: urlDraft })}
                data-testid="qc-save-url"
              >
                {t('qcSave')}
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs font-medium text-foreground">{t('qcInterval')}</span>
              <input
                type="number"
                min={5}
                max={300}
                data-testid="qc-interval"
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
                onBlur={() => void save({ poll_interval_ms: Number(intervalDraft) * 1000 })}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('qcIntervalHint')}
              </span>
            </label>
            <label className="flex items-end gap-2 pb-6 text-sm text-foreground">
              <input
                type="checkbox"
                checked={config.auto_start}
                onChange={(e) => void save({ auto_start: e.target.checked })}
                className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
              />
              {t('qcAutoStart')}
            </label>
          </div>

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
                type="password"
                data-testid="qc-token-input"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                autoComplete="off"
                placeholder={t('qcTokenPlaceholder')}
                className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void saveToken()}
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
                <p data-testid="qc-ca-fingerprint" className="break-all font-mono text-foreground">
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
                >
                  <Trash2 size={14} className="me-1" />
                  {t('qcCaRemove')}
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{t('qcCaNone')}</p>
            )}
            <input
              ref={fileRef}
              type="file"
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
                <p className="break-all font-mono text-foreground">{certDraft.fingerprint}</p>
                <label className="block">
                  <span className="block text-muted-foreground">{t('qcCaFingerprintLabel')}</span>
                  <input
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
                  data-testid="qc-ca-approve"
                >
                  {t('qcCaApprove')}
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void runTest()}
              disabled={testing}
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

          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded border border-border p-2">
              <p className="text-muted-foreground">{t('qcLastSync')}</p>
              <p className="text-foreground">{status?.last_success_at ?? t('qcNever')}</p>
            </div>
            <div className="rounded border border-border p-2">
              <p className="text-muted-foreground">{t('qcInbox')}</p>
              <p className="text-foreground">
                {t('qcInboxCounts', {
                  received: inboxSummary?.received ?? 0,
                  applied: inboxSummary?.applied ?? 0,
                  failed: inboxSummary?.failed ?? 0,
                })}
              </p>
            </div>
            <div className="rounded border border-border p-2">
              <p className="text-muted-foreground">{t('qcLastError')}</p>
              <p className="text-foreground">{status?.last_error?.code ?? t('qcNone')}</p>
            </div>
          </div>

          <p className="rounded border border-dashed border-border p-2 text-xs text-muted-foreground">
            {t('qcWssUnavailable')}
          </p>

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
              <Button type="button" size="sm" variant="outline" onClick={() => void clearErrors()}>
                {t('qcClearErrors')}
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
    </div>
  );
}
