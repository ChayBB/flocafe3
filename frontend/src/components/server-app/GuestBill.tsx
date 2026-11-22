'use client';

import { useState } from 'react';
import { CircleAlert, CircleCheck, HandCoins, Info } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { isCancelledItem } from '@/components/server-app/ItemStatus';
import type { GuestOrder } from '@/components/server-app/GuestOrderHistory';

type PaymentMethod = 'staff';

/** Why a guest's bill request failed, as the page reports it; null when it went through. */
export type GuestBillRequestFailure = 'nothing_to_bill' | 'weight_pending' | 'failed';

/** The guest's bill: what the table ordered, the backend's totals, and how to pay. */
export function GuestBill({
  order,
  tableName,
  formatPrice,
  onRequestBill,
}: {
  order: GuestOrder;
  tableName: string | null;
  formatPrice: (amount: number) => string;
  /** Asks staff to bring the bill. */
  onRequestBill: () => Promise<GuestBillRequestFailure | null>;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const tReceipt = useTranslations('receipt');
  const requested = Boolean(order.bill_requested_at);
  const [method, setMethod] = useState<PaymentMethod | null>(requested ? 'staff' : null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<GuestBillRequestFailure | null>(null);
  const requestBill = async () => {
    setSending(true);
    setFailure(null);
    setFailure(await onRequestBill());
    setSending(false);
  };
  const failureText = {
    nothing_to_bill: t('billRequestNothingYet'),
    weight_pending: t('billRequestWeightPending'),
    failed: t('billRequestFailedGuest'),
  };
  const { bill } = order;
  const billed = order.items.filter((item) => !isCancelledItem(item.status));
  const adjustments = (
    [
      [tCommon('discount'), -bill.discount_amount],
      [tReceipt('serviceCharge'), bill.service_charge],
      [bill.tax_included ? t('billTaxIncluded') : tCommon('tax'), bill.tax_amount],
      [tPos('roundOff'), bill.round_off],
    ] as [string, number][]
  ).filter(([, amount]) => amount !== 0);

  return (
    <>
      <div data-testid="server-app-guest-bill" className="flex-1 overflow-y-auto">
        <section className="px-5 pt-4 pb-5">
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <h3 className="text-lg font-bold">{t('billItemsHeading', { count: billed.length })}</h3>
            {tableName && (
              <span
                data-testid="server-app-guest-bill-table"
                className="shrink-0 rounded-full bg-muted px-3 py-1 text-sm font-medium text-muted-foreground"
              >
                {t('billTable', { table: tableName })}
              </span>
            )}
          </div>
          <ul className="divide-y divide-border/60 border-b border-border">
            {billed.map((item) => {
              const orderedBy = item.ordered_by ?? (item.ordered_by_guest ? t('guestLabel') : null);
              return (
                <li key={item.id} data-testid="server-app-guest-bill-item" className="py-3">
                  <div className="flex items-start gap-3">
                    <Ltr className="w-8 shrink-0 font-bold text-brand tabular-nums">
                      {item.quantity}x
                    </Ltr>
                    <span className="min-w-0 flex-1 font-medium">{item.product_name}</span>
                    <Ltr className="shrink-0 tabular-nums">{formatPrice(item.total)}</Ltr>
                  </div>
                  {orderedBy && (
                    <p className="mt-1 ps-11 text-sm text-muted-foreground">
                      {t('orderedBy', { name: orderedBy })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <dl className="space-y-1.5 pt-3 text-sm text-muted-foreground">
            {[[t('billSubtotal'), bill.subtotal] as [string, number], ...adjustments].map(
              ([label, amount]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt>{label}</dt>
                  <dd>
                    <Ltr className="tabular-nums">{formatPrice(amount)}</Ltr>
                  </dd>
                </div>
              ),
            )}
          </dl>
          <div className="mt-3 flex items-center justify-between gap-3 text-lg font-bold">
            <span>{bill.tax_amount ? t('billGrandTotalTaxIncluded') : t('billGrandTotal')}</span>
            <Ltr data-testid="server-app-guest-bill-total" className="tabular-nums">
              {formatPrice(bill.total)}
            </Ltr>
          </div>
        </section>

        <div aria-hidden="true" className="h-2 bg-muted" />
        <section className="px-5 pt-4 pb-6">
          <h3 className="text-lg font-bold">{t('paymentMethodHeading')}</h3>
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <Info size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
            {t('payAfterMealNotice')}
          </p>
          <div role="radiogroup" aria-label={t('paymentMethodHeading')} className="mt-3 space-y-2">
            <button
              type="button"
              role="radio"
              aria-checked={method === 'staff'}
              disabled={requested}
              onClick={() => setMethod('staff')}
              data-testid="server-app-guest-pay-staff"
              className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3.5 text-start transition-colors ${
                method === 'staff' ? 'border-brand bg-brand/5' : 'border-border'
              }`}
            >
              <HandCoins size={24} aria-hidden="true" className="shrink-0 text-brand" />
              <span className="flex-1 font-medium">{t('payWithStaff')}</span>
              <span
                aria-hidden="true"
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  method === 'staff' ? 'border-brand' : 'border-muted-foreground/50'
                }`}
              >
                {method === 'staff' && <span className="size-2.5 rounded-full bg-brand" />}
              </span>
            </button>
          </div>
          {requested && (
            <p
              role="status"
              data-testid="server-app-guest-bill-requested"
              className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              <CircleCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
              {t('billRequestSent')}
            </p>
          )}
          {failure && !requested && (
            <p
              role="alert"
              data-testid="server-app-guest-bill-request-error"
              className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
            >
              <CircleAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
              {failureText[failure]}
            </p>
          )}
        </section>
      </div>

      <footer className="shrink-0 border-t border-border bg-background px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          disabled={!method || sending || requested}
          onClick={() => void requestBill()}
          data-testid="server-app-guest-bill-continue"
          className="h-12 w-full rounded-xl bg-brand text-base font-semibold text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {requested
            ? t('billRequestedGuest')
            : sending
              ? t('billRequestSending')
              : tCommon('continue')}
        </button>
      </footer>
    </>
  );
}
