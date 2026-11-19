'use client';

import { useLocale, useTranslations } from 'use-intl';
import type { KdsOrderItem } from '@/hooks/useKdsConnection';

function formatPrice(amount: number, currency: string | undefined, locale: string): string {
  try {
    if (currency)
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {}
  return amount.toFixed(2);
}

/** The weight and price the kitchen set for a weighed or kitchen-priced line, in green. */
export function KdsSetPrice({ item, className = '' }: { item: KdsOrderItem; className?: string }) {
  const locale = useLocale();
  const tOrders = useTranslations('orders');
  if (item.kitchen_set_price == null) return null;
  return (
    <p data-testid="kds-set-price" className={`text-sm font-semibold text-green-600 ${className}`}>
      {item.weight != null && `${tOrders('weightAmount', { weight: Number(item.weight) })} · `}
      {formatPrice(item.kitchen_set_price, item.currency, locale)}
    </p>
  );
}
