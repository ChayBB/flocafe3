'use client';

import type { ButtonHTMLAttributes } from 'react';
import { List } from 'lucide-react';
import type { Category } from '@/lib/types';

export type CategoryMenuProps = {
  label: string;
  allLabel: string;
  allSelected: boolean;
  setSelectedCategory: (id: Category['id'] | null) => void;
  extraChips: { key: string; label: string; active: boolean; onSelect: () => void }[];
};

export function categoryMenuButton(label: string, props?: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      data-testid="pos-category-menu"
      aria-label={label}
      title={label}
      className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted/60 text-foreground transition-colors hover:bg-muted"
      {...props}
    >
      <List size={18} />
    </button>
  );
}
