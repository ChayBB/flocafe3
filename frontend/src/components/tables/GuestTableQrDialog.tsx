'use client';

import { useEffect, useState } from 'react';
import type { AxiosInstance } from 'axios';
import { Loader2, X } from 'lucide-react';
import { useTranslations } from 'use-intl';

interface GuestSession {
  table: { id: string; name: string };
  session: { created_at: string; expires_at: string };
  url: string;
  data_url: string;
  store_timezone?: string;
  server_app_enabled: boolean;
  guest_ordering_enabled: boolean;
}

interface Props {
  tableId: string;
  /** The POS client calls `/tables/...` on its `/api` base; the Server App calls `/api/tables/...`. */
  api: AxiosInstance;
  apiPrefix: '' | '/api';
  onClose: () => void;
}

/** The ordering QR staff hand a seated party: it works until the bill is settled or the daily reset. */
export default function GuestTableQrDialog({ tableId, api, apiPrefix, onClose }: Props) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const [data, setData] = useState<GuestSession | null>(null);
  const [failed, setFailed] = useState(false);
  const path = `${apiPrefix}/tables/${encodeURIComponent(tableId)}/guest-session`;

  useEffect(() => {
    let cancelled = false;
    api
      .post(path, {})
      .then((res) => {
        if (!cancelled) setData(res.data as GuestSession);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, path]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-3xl bg-white px-6 pb-6 pt-5 text-center text-neutral-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('shareQrTitle')}
        data-testid="guest-table-qr"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={tCommon('close')}
          className="touch-target absolute end-3 top-3 rounded-full text-neutral-800 hover:text-neutral-500"
        >
          <X size={22} />
        </button>
        <h2 className="px-10 text-base font-semibold">{t('shareQrTitle')}</h2>
        <p className="mt-1.5 text-xs text-neutral-500">{t('shareQrHint')}</p>
        {data && (
          <p className="mx-auto mt-3 w-fit rounded-full bg-neutral-100 px-4 py-1 text-sm font-medium">
            {t('tableQrTable', { name: data.table.name })}
          </p>
        )}
        {failed ? (
          <p className="py-8 text-sm text-red-500">{t('tableQrFailed')}</p>
        ) : !data ? (
          <Loader2 size={22} className="mx-auto my-16 animate-spin text-neutral-400" />
        ) : (
          <img src={data.data_url} alt="QR" className="mx-auto mt-4 block w-full max-w-60" />
        )}
      </div>
    </div>
  );
}
