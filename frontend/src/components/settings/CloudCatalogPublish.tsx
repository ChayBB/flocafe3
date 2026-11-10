'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/hooks/use-confirm';
import api from '@/lib/api';

export function CloudCatalogPublish() {
  const t = useTranslations('settings');
  const { confirm, ConfirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const [error, setError] = useState('');

  async function publish() {
    setBusy(true);
    setError('');
    setPublished(null);
    try {
      const { data } = await api.get('/qr-cloud/catalog');
      if (
        !(await confirm(t('qcCatalogConfirm', { count: data.count }), {
          confirmLabel: t('qcCatalogPublish'),
        }))
      )
        return;
      const { data: result } = await api.post('/qr-cloud/catalog', {
        confirmed: true,
        fingerprint: data.fingerprint,
      });
      setPublished(result.count);
    } catch (failure) {
      const response = (failure as { response?: { data?: { code?: string } } })?.response;
      setError(response?.data?.code ?? 'unknown');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 rounded-md border border-border p-3 text-sm">
      <h3 className="font-medium">{t('qcCatalogTitle')}</h3>
      <p className="text-muted-foreground">{t('qcCatalogHint')}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void publish()}
      >
        {t('qcCatalogPreview')}
      </Button>
      {published !== null && <p role="status">{t('qcCatalogPublished', { count: published })}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {t('qcInboxActionError', { code: error })}
        </p>
      )}
      {ConfirmDialog}
    </section>
  );
}
