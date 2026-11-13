'use client';

import { KdsScrollArea } from './KdsScrollArea';
import { useDroppable } from '@dnd-kit/react';
import { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { STATUS_CONFIG, type KitchenStatus } from '@/hooks/useKdsConnection';

export interface KdsColumnProps {
  status: KitchenStatus;
  count: number;
  children: ReactNode;
}

export function KdsColumn({ status, count, children }: KdsColumnProps) {
  const t = useTranslations('kds');
  const config = STATUS_CONFIG[status];
  const statusLabel = t(config.labelKey);

  const { ref, isDropTarget } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  return (
    <div
      data-testid={`kds-column-${status}`}
      className="flex-1 min-w-[260px] min-h-0 flex flex-col"
    >
      <div
        className={`flex items-center gap-2 px-3 py-2 ${config.bg} rounded-t-lg border border-border border-b-0`}
      >
        <div className={`w-2 h-2 rounded-full ${config.color}`} />
        <span className={`text-base font-semibold ${config.text}`}>{statusLabel}</span>
        <span className="ms-auto text-xs px-1.5 py-0.5 rounded-full bg-card/70 text-foreground font-medium tabular-nums">
          {count}
        </span>
      </div>
      <KdsScrollArea
        dropRef={ref}
        hasItems={count > 0}
        className={`flex-1 border border-border border-t-0 rounded-b-lg p-2 space-y-2 overflow-y-auto bg-muted/40 transition-colors ${
          isDropTarget ? 'bg-muted ring-2 ring-border ring-inset' : ''
        }`}
      >
        {children}
        {count === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-gray-400 text-xs">
            <span>{t('emptyColumn')}</span>
          </div>
        )}
      </KdsScrollArea>
    </div>
  );
}
