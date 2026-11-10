'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PrinterX } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { playKdsAlert, unlockKdsAlertSound } from '@/lib/kds-alert-sound';
import { extractPrinterErrorMessage, formatKotErrorToast } from '@/lib/printer/warnings';

const POLL_MS = 5000;

interface UnprintedKot {
  id: string;
  order_id: number;
  order_number: string;
  table: string | null;
  station: string;
  created_at: string;
}

/** POS-wide list of kitchen tickets the printer did not print, each with a reprint and a dismiss. */
export default function UnprintedKotAlerts() {
  const t = useTranslations('pos');
  const tKds = useTranslations('kds');
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const canPrint = tenantCan(currentTenant, 'printing.execute');
  const [unprinted, setUnprinted] = useState<UnprintedKot[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const knownRef = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ unprinted: UnprintedKot[] }>('/printers/unprinted-kots');
      const list = Array.isArray(data?.unprinted) ? data.unprinted : [];
      const known = knownRef.current;
      if (known && list.some((entry) => !known.has(entry.id))) playKdsAlert(3);
      knownRef.current = new Set(list.map((entry) => entry.id));
      setUnprinted(list);
    } catch {}
  }, []);

  useEffect(() => {
    if (!canPrint) return;
    window.addEventListener('pointerdown', unlockKdsAlertSound);
    window.addEventListener('keydown', unlockKdsAlertSound);
    void Promise.resolve().then(load);
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', unlockKdsAlertSound);
      window.removeEventListener('keydown', unlockKdsAlertSound);
    };
  }, [canPrint, load]);

  const reprint = async (entry: UnprintedKot) => {
    setBusyId(entry.id);
    try {
      await api.post('/printers/print-kot', {
        orderId: entry.order_id,
        retryStation: entry.station,
      });
      toast.success(t('unprintedKotReprinted'));
    } catch (error) {
      toast.error(
        formatKotErrorToast(extractPrinterErrorMessage(error), t('unprintedKotReprintFailed')),
      );
    } finally {
      setBusyId(null);
      await load();
    }
  };

  const dismiss = async (entry: UnprintedKot) => {
    setBusyId(entry.id);
    try {
      await api.delete(`/printers/unprinted-kots/${encodeURIComponent(entry.id)}`);
    } catch {
    } finally {
      setBusyId(null);
      await load();
    }
  };

  if (!canPrint || unprinted.length === 0) return null;

  return (
    <div
      data-testid="unprinted-kot-alerts"
      className="fixed bottom-4 end-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {unprinted.map((entry) => (
        <div
          key={entry.id}
          data-testid="unprinted-kot"
          className="flex items-start gap-3 rounded-lg border border-red-500 bg-red-600 p-3 text-white shadow-lg"
        >
          <PrinterX size={20} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t('unprintedKotTitle')}</p>
            <p className="truncate text-sm text-white/90">
              {t('unprintedKotPlace', {
                place: entry.table
                  ? tKds('tableLabel', { name: entry.table })
                  : tKds('messageOrder', { number: entry.order_number }),
                station: entry.station,
              })}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busyId === entry.id}
                onClick={() => reprint(entry)}
                className="rounded-md bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-white/90 disabled:opacity-60"
              >
                {t('unprintedKotReprint')}
              </button>
              <button
                type="button"
                disabled={busyId === entry.id}
                onClick={() => dismiss(entry)}
                className="rounded-md border border-white/60 px-3 py-1 text-sm hover:bg-white/10 disabled:opacity-60"
              >
                {t('unprintedKotDismiss')}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
