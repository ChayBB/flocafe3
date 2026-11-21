'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { getCurrencyUnitAdapter } from '@/lib/countries';
import { roundCurrencyValue } from '@/lib/currency-input';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

interface SoldByWeightProduct {
  id: string;
  name: string;
  price: number;
  unit: string;
  weighed: boolean;
  is_active: number;
  category_name: string | null;
}

/** Every menu item sold by weight, each with its price open for editing. */
export function SoldByWeightTab({
  search,
  canEdit,
  onPriceSaved,
}: {
  search: string;
  canEdit: boolean;
  onPriceSaved?: () => void;
}) {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const unitAdapter = getCurrencyUnitAdapter(currentTenant?.currency || '', currentTenant?.country);
  const fmt = useFormatCurrency();
  const [products, setProducts] = useState<SoldByWeightProduct[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/products/sold-by-weight', { signal: controller.signal })
      .then((res) => setProducts(res.data.products ?? []))
      .catch(() => {
        if (!controller.signal.aborted) {
          setProducts([]);
          toast.error(t('failedToLoad'));
        }
      });
    return () => controller.abort();
  }, [t]);

  const draftPrice = (product: SoldByWeightProduct) => drafts[product.id] ?? String(product.price);
  const parsedPrice = (product: SoldByWeightProduct) => {
    const raw = draftPrice(product).trim();
    const value = Number(raw);
    return raw !== '' && Number.isFinite(value) && value >= 0
      ? roundCurrencyValue(value, unitAdapter.maxDecimals)
      : null;
  };

  const save = async (product: SoldByWeightProduct) => {
    const price = parsedPrice(product);
    if (price === null || price === product.price) return;
    setSavingId(product.id);
    try {
      await api.put(`/products/${product.id}`, { price });
      setProducts((list) => list?.map((p) => (p.id === product.id ? { ...p, price } : p)) ?? list);
      setDrafts(({ [product.id]: _saved, ...rest }) => rest);
      onPriceSaved?.();
      toast.success(t('soldByWeightSaved', { name: product.name, price: fmt(price) }));
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      toast.error(message || t('failedToSave'));
    } finally {
      setSavingId(null);
    }
  };

  const query = search.trim().toLowerCase();
  const visible = (products ?? []).filter(
    (p) =>
      !query ||
      p.name.toLowerCase().includes(query) ||
      (p.category_name ?? '').toLowerCase().includes(query),
  );

  return (
    <div
      data-testid="sold-by-weight-list"
      className="bg-card rounded-xl border border-border flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
    >
      <p className="px-4 pt-4 text-sm text-muted-foreground">{t('soldByWeightHint')}</p>
      {products !== null && visible.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">{t('soldByWeightEmpty')}</p>
      ) : (
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">
                {t('columnProduct')}
              </th>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">
                {t('columnCategory')}
              </th>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">
                {t('columnPrice')}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((product) => {
              const price = parsedPrice(product);
              const changed = price !== null && price !== product.price;
              return (
                <tr key={product.id} className="border-t border-border">
                  <td className="p-4 text-sm">
                    <div
                      className={`font-medium ${
                        product.is_active ? 'text-foreground' : 'text-muted-foreground line-through'
                      }`}
                    >
                      {product.name}
                    </div>
                    {product.weighed && (
                      <div className="text-xs text-muted-foreground">
                        {t('soldByWeightWeighed')}
                      </div>
                    )}
                  </td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {product.category_name ?? '-'}
                  </td>
                  <td className="p-4">
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save(product);
                      }}
                    >
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step={unitAdapter.maxDecimals > 0 ? 1 / 10 ** unitAdapter.maxDecimals : 1}
                        value={draftPrice(product)}
                        disabled={!canEdit || savingId === product.id}
                        onChange={(e) => setDrafts((d) => ({ ...d, [product.id]: e.target.value }))}
                        aria-label={`${t('columnPrice')} ${product.name}`}
                        className={`w-28 rounded-lg border bg-card px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand ${
                          price === null ? 'border-red-500' : 'border-border'
                        }`}
                      />
                      <span className="text-sm text-muted-foreground">
                        {t('soldByWeightPerUnit', { unit: product.unit })}
                      </span>
                      {canEdit && (
                        <Button
                          type="submit"
                          size="sm"
                          disabled={!changed || savingId === product.id}
                        >
                          {savingId === product.id ? tCommon('saving') : tCommon('save')}
                        </Button>
                      )}
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
