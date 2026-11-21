'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { usePosSettingsStore } from '@/store/pos-settings';

type KotLayout = 'separate' | 'combined';

/** Kitchen ticket print layout: one ticket per item, or every item of the table on one ticket. */
export function KdsPrintLayoutSettings() {
  const t = useTranslations('settings');
  const [kotLayout, setKotLayout] = useState<KotLayout>(() =>
    usePosSettingsStore.getState().kotPrintSeparate ? 'separate' : 'combined',
  );
  const chosen = useRef(false);

  useEffect(() => {
    api
      .get('/settings/kot_print_layout')
      .then((res) => {
        // A choice made while this load was in flight wins over the stored value.
        if (chosen.current) return;
        const layout = res.data.setting?.value === 'separate' ? 'separate' : 'combined';
        setKotLayout(layout);
        usePosSettingsStore.getState().setKotPrintSeparate(layout === 'separate');
      })
      .catch(() => {});
  }, []);

  const saveKotLayout = async (layout: KotLayout) => {
    const previous = kotLayout;
    chosen.current = true;
    setKotLayout(layout);
    try {
      await api.put('/settings/kot_print_layout', { value: layout });
      usePosSettingsStore.getState().setKotPrintSeparate(layout === 'separate');
      toast.success(t('kotPrintLayoutSaved'));
    } catch {
      setKotLayout(previous);
      toast.error(t('saveFailed'));
    }
  };

  return (
    <div className="space-y-2 py-1" data-testid="kds-print-layout">
      {(
        [
          ['separate', t('kotPrintLayoutSeparate')],
          ['combined', t('kotPrintLayoutCombined')],
        ] as const
      ).map(([value, label]) => (
        <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={kotLayout === value}
            onChange={() => {
              if (kotLayout !== value) void saveKotLayout(value);
            }}
            className="h-4 w-4 rounded border-border text-brand focus:ring-brand"
          />
          {label}
        </label>
      ))}
    </div>
  );
}
