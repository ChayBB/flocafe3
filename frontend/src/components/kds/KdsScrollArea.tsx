'use client';

import type { ReactNode } from 'react';

export function KdsScrollArea({
  children,
  className = '',
  dropRef,
}: {
  children: ReactNode;
  className?: string;
  dropRef?: (element: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={dropRef}
      data-testid="kds-scroll-area"
      className={`min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-auto [&::-webkit-scrollbar]:w-[3px] [&::-webkit-scrollbar-thumb]:rounded-full ${className}`}
    >
      {children}
    </div>
  );
}
