'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { categoryMenuButton, type CategoryMenuProps } from './CategoryMenuButton';

/** The flat row's menu button: All and the quick filters; categories stay in the row. */
export default function CategoryMenu({
  label,
  allLabel,
  allSelected,
  setSelectedCategory,
  extraChips,
  defaultOpen,
}: CategoryMenuProps & { defaultOpen?: boolean }) {
  const itemClass = (active: boolean) =>
    `py-2.5 text-[15px] ${active ? 'font-medium text-brand' : ''}`;
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>{categoryMenuButton(label)}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] min-w-44 overflow-y-auto">
        <DropdownMenuItem
          onSelect={() => setSelectedCategory(null)}
          className={itemClass(allSelected)}
        >
          {allLabel}
        </DropdownMenuItem>
        {extraChips.map((chip) => (
          <DropdownMenuItem
            key={`quick:${chip.key}`}
            onSelect={chip.onSelect}
            className={itemClass(chip.active)}
          >
            {chip.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
