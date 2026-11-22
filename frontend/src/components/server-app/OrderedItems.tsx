'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  CheckCheck,
  ClipboardList,
  LogOut,
  Merge,
  MoreVertical,
  Plus,
  Printer,
  ShoppingBag,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfirm } from '@/hooks/use-confirm';
import { kdsItemLine } from '@/lib/item-options-note';
import { nameToColor } from '@/lib/image-utils';
import {
  ItemStatusBadge,
  KITCHEN_STAGES,
  STAGE_STYLES,
  isCancelledItem,
  stageCounts,
  stageOf,
  type KitchenStage,
} from '@/components/server-app/ItemStatus';

/** The dish as ordered, named the way the kitchen screen names it. */
export function orderedItemName(item: OrderedItem): string {
  return kdsItemLine(item).name;
}

export interface OrderedItem {
  id: number;
  product_id?: string | number;
  product_name: string;
  quantity: number;
  status: string;
  variant_selection?: unknown;
  /** Chosen options; a listed choice such as "หมู/กุ้ง" gives way to the chosen one, as on the KDS. */
  addons?: { name: string }[] | null;
  created_at?: string;
  /** A change service staff made after sending: 'takeaway' or 'cancelled'. */
  service_change?: string | null;
  /** When service staff confirmed the served item reached the table. */
  served_confirmed_at?: string | null;
  /** When the kitchen flagged the dish out of stock, asking staff to cancel it with the guest. */
  out_of_stock_at?: string | null;
  /** Still waiting for a weight or the kitchen's price. */
  weight_pending?: boolean | number | null;
  /** Line total as the backend priced it. */
  total?: number | string | null;
}

/** A dish the kitchen cannot make that still waits to be cancelled with the guest. */
export function isOutOfStock(item: OrderedItem): boolean {
  return Boolean(item.out_of_stock_at) && ['pending', 'preparing'].includes(item.status);
}

/** Any live dish not yet confirmed: staff confirm what they see at the table, whatever the kitchen shows. */
function canConfirmServed(item: OrderedItem): boolean {
  if (item.served_confirmed_at || isOutOfStock(item)) return false;
  return ['pending', 'preparing', 'ready', 'served'].includes(item.status);
}

/**
 * Any item not yet served can be packed to go; only a waiting item can be cancelled; any live
 * item can be confirmed at the table once.
 */
export function itemChangeOptions(item: OrderedItem): {
  takeaway: boolean;
  cancel: boolean;
  confirmServed: boolean;
} {
  // The kitchen cannot make it, so the only way on is to cancel it with the guest.
  if (isOutOfStock(item)) return { takeaway: false, cancel: true, confirmServed: false };
  return {
    takeaway:
      ['pending', 'preparing', 'ready'].includes(item.status) && item.service_change !== 'takeaway',
    cancel: item.status === 'pending',
    confirmServed: canConfirmServed(item),
  };
}

/** Per-stage chips for a table's order, with the orange button that opens its item list. */
export function TableKitchenSummary({
  items,
  onOpenDetails,
}: {
  items: OrderedItem[];
  onOpenDetails: () => void;
}) {
  const t = useTranslations('serverApp');
  const counts = stageCounts(items);
  return (
    <div data-testid="server-app-kitchen-summary" className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {KITCHEN_STAGES.map((stage) => (
          <span
            key={stage}
            data-testid={`server-app-stage-${stage}`}
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STAGE_STYLES[stage].className}`}
          >
            {t(STAGE_STYLES[stage].key)} <Ltr className="tabular-nums">{counts[stage]}</Ltr>
          </span>
        ))}
      </div>
      <button
        type="button"
        data-testid="server-app-ordered-items-button"
        onClick={onOpenDetails}
        aria-label={t('orderedItemsTitle')}
        title={t('orderedItemsTitle')}
        className="relative flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground"
      >
        <ClipboardList size={20} />
        <span
          className="absolute end-2 top-2 h-2.5 w-2.5 rounded-full bg-orange-500"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/**
 * A table's sent items as plain divided rows: name, quantity, price, one status pill
 * and a menu of the changes service staff may make (takeaway, cancel, confirm served).
 */
export function OrderedItemList({
  items,
  className = '',
  emptyText,
  itemTestId = 'server-app-ordered-item',
  onTakeaway,
  onCancel,
  onConfirmServed,
  formatPrice,
  imageOf,
}: {
  items: OrderedItem[];
  className?: string;
  /** The dish's menu photo, when it has one; rows show a thumbnail only when this is given. */
  imageOf?: (item: OrderedItem) => string | null;
  emptyText?: string;
  itemTestId?: string;
  formatPrice?: (amount: number) => string;
  onTakeaway: (item: OrderedItem) => Promise<void>;
  onCancel: (item: OrderedItem) => Promise<void>;
  onConfirmServed: (item: OrderedItem) => Promise<void>;
}) {
  const t = useTranslations('serverApp');
  const { confirm, ConfirmDialog } = useConfirm();
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [changing, setChanging] = useState<number | null>(null);

  const run = async (item: OrderedItem, change: 'takeaway' | 'cancel' | 'confirmServed') => {
    setMenuFor(null);
    if (change === 'cancel') {
      const ok = await confirm(t('cancelItemConfirm', { name: orderedItemName(item) }), {
        title: t('cancelItem'),
        confirmLabel: t('cancelItem'),
        destructive: true,
      });
      if (!ok) return;
    }
    setChanging(item.id);
    try {
      await (change === 'cancel'
        ? onCancel(item)
        : change === 'confirmServed'
          ? onConfirmServed(item)
          : onTakeaway(item));
    } finally {
      setChanging(null);
    }
  };

  return (
    <>
      <ol className={`divide-y divide-border ${className}`}>
        {items.length === 0 && emptyText && (
          <li className="py-10 text-center text-sm text-muted-foreground">{emptyText}</li>
        )}
        {items.map((item) => {
          const options = itemChangeOptions(item);
          const hasOptions = options.takeaway || options.cancel || options.confirmServed;
          const cancelled = isCancelledItem(item.status);
          const price =
            formatPrice && !cancelled && !item.weight_pending && item.total != null
              ? formatPrice(Number(item.total))
              : null;
          return (
            <li
              key={item.id}
              data-testid={itemTestId}
              data-out-of-stock={isOutOfStock(item) ? 'true' : undefined}
              className={`flex items-center gap-3 py-3 ${
                isOutOfStock(item)
                  ? 'rounded-lg border-s-4 border-orange-500 bg-orange-100 px-2 dark:bg-orange-950/60'
                  : ''
              }`}
            >
              {imageOf && <ItemThumb item={item} src={imageOf(item)} cancelled={cancelled} />}
              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-sm font-medium ${cancelled ? 'text-muted-foreground line-through' : ''}`}
                >
                  {orderedItemName(item)}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Ltr className="tabular-nums">x {item.quantity}</Ltr>
                  {isOutOfStock(item) && (
                    <span
                      data-testid="server-app-out-of-stock-tag"
                      className="animate-pulse font-semibold text-red-600 dark:text-red-400"
                    >
                      {t('outOfStockNeeded')}
                    </span>
                  )}
                  {item.service_change === 'takeaway' && (
                    <span
                      data-testid="server-app-takeaway-tag"
                      className="font-medium text-orange-600 dark:text-orange-300"
                    >
                      {t('takeawayTag')}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {price && <Ltr className="text-sm tabular-nums">{price}</Ltr>}
                {item.served_confirmed_at && !cancelled ? (
                  <span
                    data-testid="server-app-served-confirmed-tag"
                    className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  >
                    {t('servedConfirmedTag')}
                  </span>
                ) : (
                  <ItemStatusBadge status={item.status} />
                )}
              </div>
              {/* Rendered above the page so the footer never covers it; it opens upward near the bottom. */}
              <DropdownMenu
                modal={false}
                open={menuFor === item.id}
                onOpenChange={(open) => setMenuFor(open ? item.id : null)}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="server-app-item-menu"
                    aria-label={t('itemActions')}
                    disabled={!hasOptions || changing === item.id}
                    className={`flex min-h-11 min-w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground disabled:opacity-30 ${hasOptions ? '' : 'invisible'}`}
                  >
                    <MoreVertical size={18} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  collisionPadding={8}
                  className="min-w-48 rounded-lg border-border bg-card p-0 shadow-lg"
                >
                  {options.takeaway && (
                    <DropdownMenuItem
                      onSelect={() => void run(item, 'takeaway')}
                      className="min-h-11 rounded-none px-3 text-sm"
                    >
                      <ShoppingBag size={16} className="text-orange-600" />
                      {t('changeToTakeaway')}
                    </DropdownMenuItem>
                  )}
                  {options.confirmServed && (
                    <DropdownMenuItem
                      onSelect={() => void run(item, 'confirmServed')}
                      className="min-h-11 rounded-none px-3 text-sm text-emerald-700 dark:text-emerald-300"
                    >
                      <CheckCheck size={16} />
                      {t('confirmServed')}
                    </DropdownMenuItem>
                  )}
                  {options.cancel && (
                    <DropdownMenuItem
                      onSelect={() => void run(item, 'cancel')}
                      className="min-h-11 rounded-none px-3 text-sm text-red-600 focus:text-red-600"
                    >
                      <XCircle size={16} />
                      {t('cancelItem')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ol>
      {ConfirmDialog}
    </>
  );
}

/** A small menu photo, over a coloured tile with the name's first letters as the fallback. */
export function ItemThumb({
  item,
  src,
  cancelled,
  className = 'h-12 w-12 rounded-lg',
}: {
  item: Pick<OrderedItem, 'product_name'>;
  src: string | null;
  cancelled: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const name = item.product_name;
  return (
    <div
      data-testid="server-app-ordered-item-thumb"
      aria-hidden="true"
      className={`relative shrink-0 overflow-hidden ${className} ${cancelled ? 'opacity-40 grayscale' : ''}`}
      style={{ backgroundColor: nameToColor(name) }}
    >
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white/80">
        {name.substring(0, 2).toUpperCase()}
      </span>
      {src && !failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          draggable={false}
          className="pointer-events-none select-none [-webkit-touch-callout:none] absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  );
}

/** Dishes not yet confirmed at the table, in list order. */
/** Drinks go below the food, each group keeping its order. */
export function drinksLast(
  items: OrderedItem[],
  isDrink: (item: OrderedItem) => boolean,
): OrderedItem[] {
  return [...items.filter((item) => !isDrink(item)), ...items.filter(isDrink)];
}

export function itemsToConfirmServed(items: OrderedItem[]): OrderedItem[] {
  return items.filter(canConfirmServed);
}

/** Every dish starts ticked; untick any that has not reached the table, then confirm them together. */
function ConfirmServedDialog({
  items,
  onClose,
  onConfirm,
}: {
  items: OrderedItem[];
  onClose: () => void;
  onConfirm: (items: OrderedItem[]) => Promise<boolean>;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const chosen = items.filter((item) => !unticked.has(item.id));
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        data-testid="server-app-confirm-served-dialog"
        className="flex max-h-[85svh] flex-col gap-3 p-4 sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('confirmServedManyTitle')}</DialogTitle>
        </DialogHeader>
        <ul className="-mx-1 flex-1 overflow-y-auto">
          {items.map((item) => {
            const ticked = !unticked.has(item.id);
            return (
              <li key={item.id}>
                <label
                  data-testid="server-app-confirm-served-row"
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-1 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={saving}
                    onChange={() =>
                      setUnticked((current) => {
                        const next = new Set(current);
                        if (ticked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                    className="h-5 w-5 shrink-0 accent-emerald-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <Ltr className="font-semibold tabular-nums">{item.quantity}</Ltr>
                    {' × '}
                    {orderedItemName(item)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="h-12 rounded-lg border border-border text-sm font-semibold"
          >
            {tCommon('cancel')}
          </button>
          <button
            type="button"
            data-testid="server-app-confirm-served-submit"
            disabled={saving || chosen.length === 0}
            onClick={async () => {
              setSaving(true);
              const done = await onConfirm(chosen);
              setSaving(false);
              if (done) onClose();
            }}
            className="flex h-12 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50"
          >
            <CheckCheck size={17} />
            {t('confirmServedManySubmit', { count: chosen.length })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Full-screen list of what a table has ordered and where each item stands in the kitchen. */
export function OrderedItemsScreen({
  tableName,
  orderNumber,
  items,
  onBack,
  onAddItems,
  addItemsLocked = false,
  onTakeaway,
  onCancel,
  onConfirmServed,
  onConfirmServedMany,
  onPrintBill,
  onMoveTable,
  onMergeTable,
  serveConfirmRequested = false,
  total,
  formatPrice,
  imageOf,
}: {
  tableName: string;
  orderNumber?: string;
  items: OrderedItem[];
  onBack: () => void;
  onAddItems: () => void;
  /** The bill is out, so the table takes no more food until it is paid. */
  addItemsLocked?: boolean;
  onTakeaway: (item: OrderedItem) => Promise<void>;
  onCancel: (item: OrderedItem) => Promise<void>;
  onConfirmServed: (item: OrderedItem) => Promise<void>;
  /** Confirms several dishes reached the table in one go; resolves false when it failed. */
  onConfirmServedMany: (items: OrderedItem[]) => Promise<boolean>;
  /** Prints the table's bill and tells the POS the table is waiting to pay. */
  onPrintBill: () => Promise<void>;
  onMoveTable?: () => void;
  onMergeTable?: () => void;
  /** The cashier is waiting to print this table's bill. */
  serveConfirmRequested?: boolean;
  /** The order total as the backend priced it. */
  total?: number | string | null;
  formatPrice?: (amount: number) => string;
  imageOf?: (item: OrderedItem) => string | null;
}) {
  const t = useTranslations('serverApp');
  const tCommon = useTranslations('common');
  const [filter, setFilter] = useState<KitchenStage | 'all'>('all');
  const [printing, setPrinting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingMany, setConfirmingMany] = useState(false);
  const [confirmingOne, setConfirmingOne] = useState(false);
  const [showAcknowledgment, setShowAcknowledgment] = useState(false);
  const closeAfterAcknowledgment = useEffectEvent(onBack);
  useEffect(() => {
    if (!showAcknowledgment) return;
    const timer = setTimeout(() => closeAfterAcknowledgment(), 500);
    return () => clearTimeout(timer);
  }, [showAcknowledgment]);
  const tableActions = [
    onMoveTable && { key: 'move', label: t('moveTable'), icon: ArrowLeftRight, run: onMoveTable },
    onMergeTable && { key: 'merge', label: t('mergeTable'), icon: Merge, run: onMergeTable },
  ].filter((action) => Boolean(action)) as {
    key: string;
    label: string;
    icon: typeof Merge;
    run: () => void;
  }[];

  const live = items.filter((item) => !isCancelledItem(item.status));
  // The bill prints whenever every live item is priced; table confirmation is not required.
  const notAtTable = live.filter((item) => !item.served_confirmed_at).length;
  const confirmDishes = async (selected: OrderedItem[]) => {
    const finishesRequest = serveConfirmRequested && selected.length === notAtTable;
    const done = await onConfirmServedMany(selected);
    if (done && finishesRequest) setShowAcknowledgment(true);
    return done;
  };
  const awaitingPrice = live.filter((item) => item.weight_pending).length;
  const billReady = live.length > 0 && awaitingPrice === 0;
  const counts = stageCounts(items);
  const toConfirm = itemsToConfirmServed(live);
  // Filtering only earns a row when the items sit in more than one stage.
  const activeStages = KITCHEN_STAGES.filter((stage) => counts[stage] > 0);
  const showTabs = activeStages.length > 1;
  const activeFilter = showTabs && filter !== 'all' && counts[filter] > 0 ? filter : 'all';
  const shown =
    activeFilter === 'all' ? items : live.filter((item) => stageOf(item.status) === activeFilter);
  const tabs: { key: KitchenStage | 'all'; count: number }[] = [
    { key: 'all', count: live.length },
    ...activeStages.map((stage) => ({ key: stage, count: counts[stage] })),
  ];
  const iconButton =
    'flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted';

  return (
    <div
      data-testid="server-app-ordered-items"
      className="fixed inset-0 z-40 flex flex-col bg-background text-foreground"
    >
      <header className="border-b border-border">
        <div className="mx-auto grid w-full max-w-2xl grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-center px-2 py-2">
          <button
            type="button"
            onClick={onBack}
            aria-label={tCommon('back')}
            className={`${iconButton} justify-self-start text-foreground`}
          >
            <ArrowLeft size={20} className="rtl-flip" />
          </button>
          <div className="min-w-0 text-center">
            <h2 className="truncate text-base font-bold">{t('orderedItemsTitle')}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {t('tableLabel', { name: tableName })}
              {orderNumber && (
                <>
                  {' · '}
                  <Ltr>{orderNumber}</Ltr>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center justify-self-end">
            {orderNumber && live.length > 0 && (
              <button
                type="button"
                data-testid="server-app-print-bill"
                data-ready={billReady}
                aria-label={t('printBill')}
                title={t('printBill')}
                disabled={printing}
                onClick={async () => {
                  // A dish still waiting for its price cannot be billed yet.
                  if (!billReady) {
                    toast.error(t('printBillAwaitingPrice', { count: awaitingPrice }));
                    return;
                  }
                  setPrinting(true);
                  try {
                    await onPrintBill();
                  } finally {
                    setPrinting(false);
                  }
                }}
                className={`${iconButton} disabled:opacity-50 ${billReady ? 'text-foreground' : 'opacity-40'}`}
              >
                <Printer size={20} />
              </button>
            )}
            {orderNumber && tableActions.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="server-app-ordered-menu"
                  aria-label={t('ticketActions')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  className={iconButton}
                >
                  <MoreVertical size={20} />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute end-0 top-full z-20 mt-1 min-w-44 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
                  >
                    {tableActions.map(({ key, label, icon: Icon, run }) => (
                      <button
                        key={key}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          run();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm hover:bg-muted"
                      >
                        <Icon size={16} />
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4">
          {showTabs && (
            <div
              data-testid="server-app-ordered-stages"
              className="-mx-2 flex items-center overflow-x-auto whitespace-nowrap pt-2 text-xs text-muted-foreground"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  data-testid={`server-app-ordered-tab-${tab.key}`}
                  aria-pressed={activeFilter === tab.key}
                  onClick={() => setFilter(tab.key)}
                  className={`inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-2 ${
                    activeFilter === tab.key ? 'bg-muted font-semibold text-foreground' : ''
                  }`}
                >
                  {tab.key === 'all' ? t('filterAll') : t(STAGE_STYLES[tab.key].key)}
                  <Ltr className="tabular-nums">{tab.count}</Ltr>
                </button>
              ))}
            </div>
          )}
          <OrderedItemList
            items={shown}
            emptyText={t('noOrderedItems')}
            formatPrice={formatPrice}
            imageOf={imageOf}
            onTakeaway={onTakeaway}
            onCancel={onCancel}
            onConfirmServed={async (item) => {
              if (serveConfirmRequested) await confirmDishes([item]);
              else await onConfirmServed(item);
            }}
          />
          <div
            data-testid="server-app-ordered-actions"
            className="mb-4 mt-[70px] grid grid-cols-2 gap-2 border-t border-border pt-3"
          >
            {live.length > 0 && (
              <div
                data-testid="server-app-ordered-summary"
                className="col-span-2 flex items-baseline justify-between px-1 pb-1"
              >
                <span className="text-sm text-muted-foreground">
                  {t('orderedItemsCount', { count: live.length })}
                </span>
                {formatPrice && total != null && (
                  <Ltr className="text-lg font-bold tabular-nums">{formatPrice(Number(total))}</Ltr>
                )}
              </div>
            )}
            {toConfirm.length > 0 && (
              <button
                type="button"
                data-testid="server-app-confirm-served-many"
                disabled={confirmingOne}
                onClick={async () => {
                  // A single dish needs no checklist: confirm it straight away.
                  if (toConfirm.length > 1) {
                    setConfirmingMany(true);
                    return;
                  }
                  setConfirmingOne(true);
                  try {
                    await confirmDishes(toConfirm);
                  } finally {
                    setConfirmingOne(false);
                  }
                }}
                className={`col-span-2 flex h-12 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-sm font-semibold text-white disabled:opacity-60 ${serveConfirmRequested ? 'animate-pulse ring-2 ring-red-500' : ''}`}
              >
                <CheckCheck size={17} />
                {t('confirmServedMany', { count: toConfirm.length })}
              </button>
            )}
            <button
              type="button"
              data-testid="server-app-ordered-add"
              onClick={onAddItems}
              disabled={addItemsLocked}
              className="flex h-12 items-center justify-center gap-1.5 rounded-lg border border-brand text-sm font-semibold text-brand disabled:opacity-40"
            >
              <Plus size={17} />
              {t('addFoodItems')}
            </button>
            <button
              type="button"
              data-testid="server-app-ordered-exit"
              onClick={onBack}
              className="flex h-12 items-center justify-center gap-1.5 rounded-lg border border-border text-sm font-semibold text-foreground"
            >
              <LogOut size={17} className="rtl-flip" />
              {t('exitOrderedItems')}
            </button>
          </div>
        </div>
      </div>
      {confirmingMany && (
        <ConfirmServedDialog
          items={toConfirm}
          onClose={() => setConfirmingMany(false)}
          onConfirm={confirmDishes}
        />
      )}
      {showAcknowledgment && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/75">
          <p
            role="status"
            className="rounded-xl border border-border bg-card px-6 py-4 text-lg font-semibold"
          >
            {t('serveConfirmThanks')}
          </p>
        </div>
      )}
    </div>
  );
}
