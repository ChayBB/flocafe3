'use client';

import { useState } from 'react';
import { ChevronLeft, ReceiptText, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Ltr } from '@/components/layout/Ltr';
import { ItemStatusBadge, isCancelledItem } from '@/components/server-app/ItemStatus';
import { ItemThumb } from '@/components/server-app/OrderedItems';
import { GuestBill, type GuestBillRequestFailure } from '@/components/server-app/GuestBill';

export interface GuestOrderItem {
  id: number;
  product_id: string;
  product_name: string;
  quantity: number;
  status: string;
  total: number;
  ordered_by: string | null;
  ordered_by_guest: boolean;
  saved_price?: { entry_id: number; unit_price: number; weight: number | null };
}

export interface GuestOrder {
  order_number: string;
  customer_name: string | null;
  bill_requested_at: string | null;
  items: GuestOrderItem[];
  bill: {
    subtotal: number;
    discount_amount: number;
    service_charge: number;
    tax_amount: number;
    tax_included: boolean;
    round_off: number;
    total: number;
  };
}

const ICON_BUTTON =
  'flex size-10 items-center justify-center rounded-full text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand';

/** What this table has ordered during the current visit, with each dish's kitchen status and the bill. */
export function GuestOrderHistory({
  open,
  onClose,
  order,
  loading,
  asOf,
  tableName,
  onRequestBill,
  formatPrice,
  formatTime,
  imageOf,
}: {
  open: boolean;
  onClose: () => void;
  order: GuestOrder | null;
  loading: boolean;
  /** When the server read the order, so guests know how fresh the statuses are. */
  asOf: string | null;
  tableName: string | null;
  onRequestBill: () => Promise<GuestBillRequestFailure | null>;
  formatPrice: (amount: number) => string;
  formatTime: (iso: string) => string;
  imageOf: (item: GuestOrderItem) => string | null;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [showBill, setShowBill] = useState(false);
  const billed = order?.items.filter((item) => !isCancelledItem(item.status)) ?? [];
  const close = () => {
    setShowBill(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        data-testid="server-app-guest-history"
        showCloseButton={false}
        className="top-0 left-0 flex h-[100dvh] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:top-[50%] sm:left-[50%] sm:h-[85vh] sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%] sm:overflow-hidden sm:rounded-2xl sm:border"
      >
        <header className="grid shrink-0 grid-cols-[2.5rem_1fr_2.5rem] items-center gap-2 border-b border-border px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 shadow-sm">
          {showBill ? (
            <button
              type="button"
              onClick={() => setShowBill(false)}
              aria-label={tCommon('back')}
              data-testid="server-app-guest-bill-back"
              className={ICON_BUTTON}
            >
              <ChevronLeft size={28} aria-hidden="true" className="rtl:rotate-180" />
            </button>
          ) : (
            <button
              type="button"
              onClick={close}
              aria-label={tCommon('close')}
              data-testid="server-app-guest-history-close"
              className={ICON_BUTTON}
            >
              <X size={26} aria-hidden="true" />
            </button>
          )}
          <div className="min-w-0 text-center">
            <DialogTitle className="truncate text-xl font-bold">
              {showBill ? t('viewBill') : t('itemsOrdered')}
            </DialogTitle>
            <DialogDescription
              data-testid="server-app-guest-history-as-of"
              className={showBill ? 'sr-only' : 'mt-0.5 text-sm text-muted-foreground'}
            >
              {asOf ? t('orderHistoryAsOf', { time: formatTime(asOf) }) : ' '}
            </DialogDescription>
          </div>
        </header>

        {!order || order.items.length === 0 ? (
          <p className="flex-1 px-6 py-10 text-center text-sm text-muted-foreground">
            {loading ? t('orderHistoryLoading') : t('orderHistoryEmpty')}
          </p>
        ) : showBill ? (
          <GuestBill
            order={order}
            tableName={tableName}
            formatPrice={formatPrice}
            onRequestBill={onRequestBill}
          />
        ) : (
          <ul className="flex-1 divide-y divide-border overflow-y-auto px-5">
            {order.items.map((item) => {
              const cancelled = isCancelledItem(item.status);
              const orderedBy = item.ordered_by ?? (item.ordered_by_guest ? t('guestLabel') : null);
              return (
                <li key={item.id} data-testid="server-app-guest-history-item" className="py-4">
                  <div className="flex gap-3">
                    <ItemThumb
                      item={item}
                      src={imageOf(item)}
                      cancelled={cancelled}
                      className="size-[4.5rem] rounded-xl"
                    />
                    <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <p
                          className={`line-clamp-2 min-w-0 font-medium ${cancelled ? 'text-muted-foreground line-through' : ''}`}
                        >
                          {item.product_name}
                        </p>
                        <Ltr
                          className={`shrink-0 font-semibold tabular-nums ${cancelled ? 'text-muted-foreground line-through' : ''}`}
                        >
                          {formatPrice(item.total)}
                        </Ltr>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <Ltr className="text-lg font-bold tabular-nums">x {item.quantity}</Ltr>
                        <ItemStatusBadge status={item.status} className="px-3 py-1 text-sm" />
                      </div>
                    </div>
                  </div>
                  {orderedBy && (
                    <p
                      data-testid="server-app-guest-history-ordered-by"
                      className="mt-2 text-sm text-muted-foreground"
                    >
                      {t('orderedBy', { name: orderedBy })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {order && order.items.length > 0 && !showBill && (
          <footer className="shrink-0 space-y-3 border-t border-border bg-background px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_-8px_rgb(0_0_0/0.15)]">
            <div className="flex items-center justify-between gap-3 text-lg font-bold">
              <span data-testid="server-app-guest-history-count">
                {t('orderHistoryCount', { count: billed.length })}
              </span>
              <Ltr data-testid="server-app-guest-history-total" className="tabular-nums">
                {formatPrice(order.bill.total)}
              </Ltr>
            </div>
            <button
              type="button"
              onClick={() => setShowBill(true)}
              data-testid="server-app-guest-bill-button"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-brand text-base font-semibold text-brand hover:bg-brand/10"
            >
              <ReceiptText size={22} aria-hidden="true" />
              {t('viewBill')}
            </button>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
}
