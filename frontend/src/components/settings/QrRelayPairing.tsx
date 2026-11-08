'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';

type RelayStatus = {
  server_url: string;
  state: 'unpaired' | 'pairing' | 'paired';
  connected: boolean;
  public_base_url: string;
  pairing: { code: string; qr_data_url: string; expires_at: string } | null;
  last_error: string | null;
};

const ERROR_KEYS = {
  server_url_invalid: 'qrRelayErrorInvalid',
  relay_unreachable: 'qrRelayErrorUnreachable',
  relay_bad_response: 'qrRelayErrorUnreachable',
  pairing_expired: 'qrRelayErrorExpired',
  pairing_rejected: 'qrRelayErrorRejected',
  unknown_store: 'qrRelayErrorUnknownStore',
} as const;

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Pairs this POS with a QR ordering relay by a short code, so customers can order over mobile data. */
export function QrRelayPairing({
  disabled,
  showRelayPairing = true,
}: {
  disabled: boolean;
  showRelayPairing?: boolean;
}) {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef<RelayStatus['state'] | null>(null);

  const apply = useCallback(
    (next: RelayStatus) => {
      if (stateRef.current === 'pairing' && next.state === 'paired') {
        toast.success(t('qrRelayPairedToast'));
      }
      stateRef.current = next.state;
      setStatus(next);
    },
    [t],
  );

  useEffect(() => {
    if (!showRelayPairing) return;
    let cancelled = false;
    api
      .get('/qr-relay')
      .then(({ data }) => {
        if (cancelled) return;
        stateRef.current = data.state;
        setStatus(data);
        setServerUrl(data.server_url || '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showRelayPairing]);

  const state = status?.state;
  useEffect(() => {
    if (!showRelayPairing) return;
    if (state !== 'pairing' && state !== 'paired') return;
    const poll = () => {
      const request = state === 'pairing' ? api.post('/qr-relay/pair/check') : api.get('/qr-relay');
      request.then(({ data }) => apply(data)).catch(() => {});
    };
    const timer = window.setInterval(poll, state === 'pairing' ? 3000 : 10000);
    const clock =
      state === 'pairing' ? window.setInterval(() => setNow(Date.now()), 1000) : undefined;
    return () => {
      window.clearInterval(timer);
      if (clock) window.clearInterval(clock);
    };
  }, [state, apply, showRelayPairing]);

  // The integrated Cloud Connector replaces the legacy pairing panel; the settings page keeps
  // the stickers and QR-rotation actions outside this component.
  if (!showRelayPairing) return null;

  const errorText = (code: string | null | undefined) =>
    code ? t(ERROR_KEYS[code as keyof typeof ERROR_KEYS] ?? 'qrRelayErrorGeneric') : '';
  const run = async (action: () => Promise<{ data: RelayStatus }>) => {
    setBusy(true);
    try {
      const { data } = await action();
      apply(data);
      return data;
    } catch (error: unknown) {
      const data = axios.isAxiosError(error) ? error.response?.data : undefined;
      if (data?.state) apply(data);
      toast.error(errorText(data?.code) || t('saveFailed'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setNow(Date.now());
    await run(() => api.post('/qr-relay/pair', { server_url: serverUrl }));
  };

  const unpair = async () => {
    const ok = await confirm(t('qrRelayUnpairConfirm'), {
      title: t('qrRelayUnpair'),
      confirmLabel: t('qrRelayUnpair'),
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => api.delete('/qr-relay'))) {
      toast.success(t('qrRelayUnpaired'));
    }
  };

  const off = disabled || !status || busy;
  const inputClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand disabled:opacity-50';

  return (
    <div data-testid="settings-qr-relay" className="space-y-2 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium text-foreground">{t('qrRelayTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('qrRelayHint')}</p>
      </div>

      {(!status || status.state === 'unpaired') && (
        <div className="space-y-2">
          <label htmlFor="qr-relay-server" className="block text-sm font-medium text-foreground">
            {t('qrRelayServerLabel')}
          </label>
          <input
            id="qr-relay-server"
            type="url"
            inputMode="url"
            placeholder="https://qr.example.com"
            value={serverUrl}
            disabled={off}
            onChange={(event) => setServerUrl(event.target.value)}
            className={inputClass}
          />
          {status?.last_error && (
            <p className="text-xs text-destructive">{errorText(status.last_error)}</p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={off || !serverUrl.trim()}
            onClick={() => void start()}
          >
            {t('qrRelayStart')}
          </Button>
        </div>
      )}

      {status?.state === 'pairing' && status.pairing && (
        <div className="flex flex-wrap items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={status.pairing.qr_data_url}
            alt={t('qrRelayCodeLabel')}
            className="h-40 w-40 rounded-md border border-border bg-white p-1"
          />
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('qrRelayCodeLabel')}</p>
            <p
              data-testid="qr-relay-code"
              className="font-mono text-3xl font-bold tracking-[0.3em] text-foreground"
            >
              {status.pairing.code}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('qrRelayExpires', { time: remaining(status.pairing.expires_at, now) })}
            </p>
            <p className="text-xs text-muted-foreground">{t('qrRelayPairingHint')}</p>
            <p className="text-sm text-foreground">{t('qrRelayWaiting')}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => api.delete('/qr-relay/pair'))}
            >
              {t('qrRelayCancelPairing')}
            </Button>
          </div>
        </div>
      )}

      {status?.state === 'paired' && (
        <div className="space-y-2">
          <p
            data-testid="qr-relay-state"
            className={
              status.connected
                ? 'text-sm font-medium text-green-600'
                : 'text-sm font-medium text-amber-600'
            }
          >
            {status.connected ? t('qrRelayConnected') : t('qrRelayReconnecting')}
          </p>
          {status.public_base_url && (
            <p className="text-xs break-all text-muted-foreground">
              {t('qrRelayPublicUrl', { url: status.public_base_url })}
            </p>
          )}
          {!status.connected && status.last_error && (
            <p className="text-xs text-destructive">{errorText(status.last_error)}</p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={off}
            onClick={() => void unpair()}
          >
            {t('qrRelayUnpair')}
          </Button>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
