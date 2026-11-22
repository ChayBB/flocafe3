'use client';

import { useTranslations, type AppConfig } from 'use-intl';
import { TERMINAL_ITEM_STATUSES } from '@shared/order-item-status';

type ServerAppKey = keyof AppConfig['Messages']['serverApp'];

/** The four kitchen stages a sent item moves through, in order. */
export const KITCHEN_STAGES = ['pending', 'preparing', 'ready', 'served'] as const;
export type KitchenStage = (typeof KITCHEN_STAGES)[number];

export const STAGE_STYLES: Record<KitchenStage, { key: ServerAppKey; className: string }> = {
  pending: {
    key: 'statusWaiting',
    className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  },
  preparing: {
    key: 'statusPreparing',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  ready: {
    key: 'statusReady',
    className: 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300',
  },
  served: {
    key: 'statusServed',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  },
};
const CANCELLED_STYLE = {
  key: 'statusCancelled' as ServerAppKey,
  className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

export function isCancelledItem(status: string): boolean {
  return TERMINAL_ITEM_STATUSES.includes(status);
}

/** The stage an item counts under; `completed` reads as served. */
export function stageOf(status: string): KitchenStage {
  if (status === 'completed') return 'served';
  return (KITCHEN_STAGES as readonly string[]).includes(status)
    ? (status as KitchenStage)
    : 'pending';
}

/** Per-stage counts of an order's live (not cancelled) items. */
export function stageCounts(items: { status: string }[]): Record<KitchenStage, number> {
  const counts: Record<KitchenStage, number> = { pending: 0, preparing: 0, ready: 0, served: 0 };
  for (const item of items) {
    if (!isCancelledItem(item.status)) counts[stageOf(item.status)] += 1;
  }
  return counts;
}

/** The kitchen status of a sent item, spelled out. */
export function ItemStatusBadge({
  status,
  className = 'px-2 py-0.5 text-xs',
}: {
  status: string;
  className?: string;
}) {
  const t = useTranslations('serverApp');
  const style = isCancelledItem(status) ? CANCELLED_STYLE : STAGE_STYLES[stageOf(status)];
  return (
    <span
      data-testid="server-app-item-status"
      className={`shrink-0 whitespace-nowrap rounded-full font-medium ${className} ${style.className}`}
    >
      {t(style.key)}
    </span>
  );
}
