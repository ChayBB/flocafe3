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
        className="relative flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl bg-card p-6 text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('guestQrTitle')}
        data-testid="guest-table-qr"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={tCommon('close')}
          className="touch-target absolute end-2 top-2 rounded-full text-muted-foreground hover:text-foreground"
        >
          <X size={18} />
        </button>
        {failed ? (
          <p className="py-6 text-center text-sm text-red-500">{t('tableQrFailed')}</p>
        ) : !data ? (
          <Loader2 size={22} className="my-10 animate-spin text-muted-foreground" />
        ) : (
          <img src={data.data_url} alt="QR" className="w-56 rounded-lg bg-white p-2" />
        )}
      </div>
    </div>
  );
}
