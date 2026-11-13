'use client';

import { useCallback, useRef, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, History } from 'lucide-react';
import { useTranslations } from 'use-intl';

export function KdsScrollArea({
  children,
  className = '',
  dropRef,
  hasItems = true,
}: {
  children: ReactNode;
  className?: string;
  dropRef?: (element: HTMLElement | null) => void;
  hasItems?: boolean;
}) {
  const t = useTranslations('kds');
  const area = useRef<HTMLDivElement | null>(null);
  const bind = useCallback(
    (element: HTMLDivElement | null) => {
      area.current = element;
      dropRef?.(element);
    },
    [dropRef],
  );
  const page = (direction: number) => {
    const element = area.current;
    if (element)
      element.scrollBy({ top: direction * element.clientHeight * 0.8, behavior: 'smooth' });
  };
  const latest = () => {
    const element = area.current;
    if (!element) return;
    const cards = [...element.querySelectorAll<HTMLElement>('[data-kds-scroll-time]')];
    const target = cards.reduce<HTMLElement | null>(
      (newest, card) =>
        !newest || Number(card.dataset.kdsScrollTime) >= Number(newest.dataset.kdsScrollTime)
          ? card
          : newest,
      null,
    );
    element.scrollTo({
      top: target
        ? target.getBoundingClientRect().top -
          element.getBoundingClientRect().top +
          element.scrollTop
        : element.scrollHeight,
      behavior: 'smooth',
    });
  };
  return (
    <>
      <div
        ref={bind}
        data-testid="kds-scroll-area"
        className={`min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-auto ${className}`}
      >
        {children}
      </div>
      {hasItems && (
        <div
          className="flex shrink-0 items-center gap-2 border border-t-0 border-border bg-card p-2"
          data-testid="kds-scroll-controls"
        >
          <button
            type="button"
            onClick={() => page(-1)}
            aria-label={t('scrollUp')}
            title={t('scrollUp')}
            className="flex h-12 min-w-12 items-center justify-center rounded-lg border border-border bg-muted active:bg-muted/60"
          >
            <ArrowUp size={22} />
          </button>
          <button
            type="button"
            onClick={() => page(1)}
            aria-label={t('scrollDown')}
            title={t('scrollDown')}
            className="flex h-12 min-w-12 items-center justify-center rounded-lg border border-border bg-muted active:bg-muted/60"
          >
            <ArrowDown size={22} />
          </button>
          <button
            type="button"
            onClick={latest}
            className="flex h-12 min-w-12 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 text-sm font-semibold active:bg-muted/60"
          >
            <History size={20} />
            {t('scrollLatest')}
          </button>
        </div>
      )}
    </>
  );
}
