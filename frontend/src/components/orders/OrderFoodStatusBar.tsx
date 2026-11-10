'use client';

import { useTranslations } from 'use-intl';
import type { OrderItem } from '@/lib/types';
import { itemStatusDot } from '@/components/orders/OrderCard';

const STAGES = ['pending', 'preparing', 'ready', 'served'] as const;
export type FoodStage = (typeof STAGES)[number];

function stageCounts(items: OrderItem[]): number[] {
  return STAGES.map((stage) => items.filter((item) => item.status === stage).length);
}

/** A compact dot and count per food stage; tapping one filters the item list. */
export function OrderFoodStageCounts({
  items,
  selected,
  onSelect,
}: {
  items: OrderItem[];
  selected: FoodStage | null;
  onSelect: (stage: FoodStage | null) => void;
}) {
  const t = useTranslations('orders');
  const counts = stageCounts(items);
  if (counts.every((count) => count === 0)) return null;

  return (
    <div
      data-testid="order-food-status"
      aria-label={t('foodStatus')}
      className="flex items-center gap-0.5 text-xs text-muted-foreground"
    >
      {STAGES.map((stage, index) => {
        const label = t(itemStatusDot[stage].labelKey);
        return (
          <button
            key={stage}
            type="button"
            data-testid={`order-food-status-${stage}`}
            aria-pressed={selected === stage}
            title={label}
            disabled={counts[index] === 0 && selected !== stage}
            onClick={() => onSelect(selected === stage ? null : stage)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 enabled:hover:bg-muted/60 ${
              selected === stage ? 'bg-muted font-semibold text-foreground' : ''
            } ${counts[index] > 0 ? '' : 'opacity-50'}`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full opacity-75 ${itemStatusDot[stage].dot}`}
            />
            <span className="sr-only">{label}</span>
            <span className="font-medium tabular-nums text-foreground/80">{counts[index]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A thin full-width bar split by how many items sit in each food stage. */
export function OrderFoodProgressBar({ items }: { items: OrderItem[] }) {
  const counts = stageCounts(items);
  if (counts.every((count) => count === 0)) return null;
  return (
    // Colours sit at 75% so the bar reads as a hint, not a warning.
    <div aria-hidden="true" className="mt-1 flex h-1 gap-0.5">
      {STAGES.map((stage, index) =>
        counts[index] > 0 ? (
          <div
            key={stage}
            className={`rounded-full opacity-75 ${itemStatusDot[stage].dot}`}
            style={{ flexGrow: counts[index], flexBasis: 0 }}
          />
        ) : null,
      )}
    </div>
  );
}
