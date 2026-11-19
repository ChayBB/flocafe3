'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { STATUS_CONFIG, type KitchenStatus } from '@/hooks/useKdsConnection';
import { nextKitchenStatus } from '@/lib/kds-stages';

/** One-tap advance of an item to its next kitchen stage. */
export function KdsStatusToggle({
  status,
  skipped,
  disabled,
  onAdvance,
  labelKey = 'advanceTo',
  testId = 'kds-status-toggle',
}: {
  status: KitchenStatus;
  skipped?: readonly KitchenStatus[];
  disabled?: boolean;
  onAdvance: (next: KitchenStatus) => void;
  labelKey?: 'advanceTo' | 'advanceAllTo';
  testId?: string;
}) {
  const t = useTranslations('kds');
  const next = nextKitchenStatus(status, skipped);
  if (!next) return null;
  const nextConfig = STATUS_CONFIG[next];
  const label = t(labelKey, { status: t(nextConfig.labelKey) });

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAdvance(next);
      }}
      className="shrink-0 min-w-11 min-h-11 flex items-center justify-center disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5 h-8 ps-2.5 pe-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:scale-95 transition">
        <span className={`w-2.5 h-2.5 rounded-full ${nextConfig.color}`} />
        <ChevronRight size={16} className="rtl-flip" />
      </span>
    </button>
  );
}
