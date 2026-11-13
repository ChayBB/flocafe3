'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Ltr } from '@/components/layout/Ltr';
import { Button } from '@/components/ui/button';

interface ConnectionInfo {
  ip_url: string;
  qr_data_url: string | null;
  ips_data?: { ip: string; url: string; qr_data: string | null }[];
}

export function KdsStationAccess() {
  const t = useTranslations('settings');
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<ConnectionInfo>('/kds-info', { signal: controller.signal })
      .then(({ data }) => {
        if (!controller.signal.aborted) setInfo(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [revision]);

  const links = info?.ips_data?.length
    ? info.ips_data
    : info
      ? [{ url: info.ip_url, qr_data: info.qr_data_url }]
      : [];

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      data-testid="station-kds-access"
    >
      <h3 className="text-sm font-semibold">{t('kdsPairing')}</h3>
      <p className="text-xs text-muted-foreground">{t('kdsPairingHint')}</p>
      {failed ? (
        <p className="text-sm text-destructive">{t('kdsInfoFetchFailed')}</p>
      ) : !info ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {links.map((link) => (
            <div key={link.url} className="flex flex-col items-center gap-2">
              {link.qr_data && (
                <img
                  src={link.qr_data}
                  alt={t('kdsQrAlt')}
                  className="size-36 rounded-lg bg-white"
                />
              )}
              <Ltr
                as="a"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-center font-mono text-xs text-brand hover:underline"
              >
                {link.url}
              </Ltr>
            </div>
          ))}
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setFailed(false);
          setInfo(null);
          setRevision((value) => value + 1);
        }}
      >
        {t('refreshUrls')}
      </Button>
    </section>
  );
}
