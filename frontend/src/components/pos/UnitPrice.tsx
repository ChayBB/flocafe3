import { useTranslations } from 'use-intl';

const plainAmount = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });

/** A price quoted per unit, such as 180 บาท/กก. for a dish priced by weight. */
export function UnitPrice({
  amount,
  unit,
  currency,
  format,
}: {
  amount: number;
  unit: string;
  currency: string;
  format: (amount: number) => string;
}) {
  const t = useTranslations('pos');
  if (currency === 'THB' || currency === '฿') return <>{t('bahtPerUnit', { price: plainAmount.format(amount), unit })}</>;
  return (
    <>
      {format(amount)}
      {t('pricePerSaleUnit', { unit })}
    </>
  );
}
