'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';

/** Matches the ordering page's own default when the branch has not chosen one. */
const DEFAULT_SCROLL_PERCENT = 87;

function failureCode(failure: unknown): string {
  return (
    (failure as { response?: { data?: { code?: string } } })?.response?.data?.code ?? 'unknown'
  );
}

export function CloudGuestScroll() {
  const t = useTranslations('settings');
  const [saved, setSaved] = useState<number | null | undefined>(undefined);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/qr-cloud/guest-settings')
      .then(({ data }) => {
        if (cancelled) return;
        setSaved(data.scroll_percent);
        setValue(String(data.scroll_percent ?? DEFAULT_SCROLL_PERCENT));
      })
      .catch((failure) => {
        if (!cancelled) setError(failureCode(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const percent = Number(value);
  const valid = Number.isInteger(percent) && percent >= 50 && percent <= 100;

  async function save() {
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const { data } = await api.put('/qr-cloud/guest-settings', { scroll_percent: percent });
      setSaved(data.scroll_percent);
      setDone(true);
    } catch (failure) {
      setError(failureCode(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 rounded-md border border-border p-3 text-sm">
      <h3 className="font-medium">{t('qcScrollTitle')}</h3>
      <p className="text-muted-foreground">{t('qcScrollHint')}</p>
      <div className="flex items-end gap-2">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">{t('qcScrollLabel')}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={50}
            max={100}
            step={1}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setDone(false);
            }}
            className="w-24"
            data-testid="qc-scroll-percent"
          />
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !valid || saved === undefined || percent === saved}
          onClick={() => void save()}
        >
          {t('qcScrollSave')}
        </Button>
      </div>
      {saved === null && !done && (
        <p className="text-xs text-muted-foreground">
          {t('qcScrollUnset', { percent: DEFAULT_SCROLL_PERCENT })}
        </p>
      )}
      {done && saved != null && <p role="status">{t('qcScrollSaved', { percent: saved })}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {t('qcInboxActionError', { code: error })}
        </p>
      )}
    </section>
  );
}
