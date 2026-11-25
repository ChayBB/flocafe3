'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { StaffTablesDialogTable } from './StaffTablesDialog';

const COLLAPSED_KEY = 'flocafe:table-zone-board-collapsed';

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** Every active table by zone: assigned ones green with their staff member, unassigned ones white. */
export default function TableZoneBoard({
  tables,
  staffNames,
}: {
  tables: StaffTablesDialogTable[];
  staffNames: Map<string, string>;
}) {
  const t = useTranslations('tables');
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1',
  );
  const toggle = () => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '0' : '1');
    setCollapsed(!collapsed);
  };
  const zones = [
    ...tables
      .reduce((map, table) => {
        const zone = table.floor?.trim() ?? '';
        return map.set(zone, [...(map.get(zone) ?? []), table]);
      }, new Map<string, StaffTablesDialogTable[]>())
      .entries(),
  ]
    .map(([zone, list]) => ({ zone, list: list.sort(byName) }))
    .sort((a, b) => (a.zone ? 0 : 1) - (b.zone ? 0 : 1) || byName(a.list[0], b.list[0]));

  return (
    <section
      className={`min-w-0 rounded-2xl border border-border bg-card p-6 ${collapsed ? 'w-full lg:w-auto' : 'flex-1'}`}
      data-testid="table-zone-board"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        data-testid="table-zone-board-toggle"
        className="flex w-full items-center justify-between gap-3 text-start text-sm font-semibold text-foreground"
      >
        {t('zoneBoardTitle')}
        <ChevronDown
          size={18}
          className={`shrink-0 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>
      {collapsed ? null : zones.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('zoneBoardEmpty')}</p>
      ) : (
        <div className="mt-4 space-y-5">
          {zones.map(({ zone, list }) => {
            const assigned = list.filter((table) => table.owner_user_id).length;
            return (
              <div key={zone || '-'} data-testid="table-zone-board-zone" data-zone={zone}>
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {zone || t('rezoneNoZone')}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {t('zoneBoardAssigned', { assigned, total: list.length })}
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
                  {list.map((table) => {
                    const owner = table.owner_user_id
                      ? (table.owner_name ?? staffNames.get(table.owner_user_id) ?? '—')
                      : null;
                    const backup = table.backup_user_id
                      ? staffNames.get(table.backup_user_id)
                      : undefined;
                    return (
                      <div
                        key={table.id}
                        data-testid={`table-zone-board-table-${table.name}`}
                        data-table-owner={owner ?? undefined}
                        className={`flex min-h-16 min-w-0 flex-col items-center justify-center rounded-xl border-2 px-2 py-2 text-center ${
                          owner
                            ? 'border-green-600 bg-[#EEF8F1] dark:border-green-500 dark:bg-green-950/40'
                            : 'border-border bg-white dark:bg-background'
                        }`}
                      >
                        <span className="text-base font-bold leading-tight text-foreground">
                          {table.name}
                        </span>
                        <span
                          className={`max-w-full truncate text-xs ${
                            owner
                              ? 'font-semibold text-green-800 dark:text-green-300'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {owner ?? t('zoneBoardUnassigned')}
                        </span>
                        {backup && (
                          <span className="max-w-full truncate text-[11px] text-amber-700 dark:text-amber-300">
                            {t('zoneBoardBackup', { name: backup })}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
