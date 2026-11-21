'use client';

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
export const TABLE_USER_STYLE =
  'inline-flex h-[38px] min-w-0 max-w-full items-center gap-2 rounded-[10px] border border-[#E5E5E5] bg-white/85 px-[10px] font-sans text-sm font-medium leading-5 tracking-normal text-[#111111]';

export function TableUserLabel({
  tableName,
  userName,
}: {
  tableName: string;
  userName?: ReactNode;
}) {
  return (
    <span data-testid="server-app-header-table" className="flex min-w-0 items-center gap-2">
      <span className="truncate">{tableName}</span>
      {userName && (
        <>
          <span aria-hidden="true" className="shrink-0">
            |
          </span>
          <span data-testid="server-app-header-customer" className="min-w-0 truncate">
            {userName}
          </span>
        </>
      )}
    </span>
  );
}

export function TableUserSelector({
  tableName,
  userName,
  onShowTables,
  expanded,
  disabled,
  label,
}: {
  tableName: string;
  userName?: ReactNode;
  onShowTables?: () => void;
  expanded?: boolean;
  disabled?: boolean;
  label: string;
}) {
  const content = (
    <>
      <TableUserLabel tableName={tableName} userName={userName} />
      <ChevronDown size={16} aria-hidden="true" className="ms-auto shrink-0" />
    </>
  );
  if (!onShowTables)
    return (
      <div data-testid="server-app-table-label" className={TABLE_USER_STYLE}>
        <TableUserLabel tableName={tableName} userName={userName} />
      </div>
    );
  return (
    <button
      type="button"
      onClick={onShowTables}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls="server-app-table-picker"
      data-testid="server-app-table-button"
      className={`${TABLE_USER_STYLE} transition-colors hover:bg-neutral-50 active:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50`}
    >
      {content}
    </button>
  );
}
