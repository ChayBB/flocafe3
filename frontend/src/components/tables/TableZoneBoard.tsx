'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { StaffTablesDialogTable } from './StaffTablesDialog';

const COLLAPSED_KEY = 'flocafe:table-zone-board-collapsed';

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** Neighbouring tables with the same main and backup staff, shown as one block. */
function staffRuns(list: StaffTablesDialogTable[]) {
  const runs: {
    ownerId: string | null;
    backupId: string | null;
    tables: StaffTablesDialogTable[];
  }[] = [];
  for (const table of list) {
    const last = runs[runs.length - 1];
    const ownerId = table.owner_user_id ?? null;
    const backupId = ownerId ? (table.backup_user_id ?? null) : null;
    if (last && last.ownerId === ownerId && last.backupId === backupId) last.tables.push(table);
    else runs.push({ ownerId, backupId, tables: [table] });
  }
  return runs;
}

/** Every active table by zone, one block per main staff member (blue) with their backup (orange). */
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
        <>
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            {zones.map(({ zone, list }) => {
              const assigned = list.filter((table) => table.owner_user_id).length;
              return (
                <div
                  key={zone || '-'}
                  data-testid="table-zone-board-zone"
                  data-zone={zone}
                  className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-border dark:bg-background"
                >
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <p className="text-base font-bold text-slate-800 dark:text-foreground">
                      {zone || t('rezoneNoZone')}
                      <span className="ms-2 text-sm font-medium text-slate-500 dark:text-muted-foreground">
                        {t('rezoneTableCount', { count: list.length })}
                      </span>
                    </p>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        assigned === list.length
                          ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                          : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
                      }`}
                    >
                      {t('zoneBoardAssigned', { assigned, total: list.length })}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {staffRuns(list).map((run) => {
                      const owner = run.ownerId
                        ? (run.tables[0].owner_name ?? staffNames.get(run.ownerId) ?? '—')
                        : null;
                      const backup = run.backupId ? staffNames.get(run.backupId) : undefined;
                      return (
                        <div
                          key={run.tables[0].id}
                          data-testid="table-zone-board-run"
                          data-owner={owner ?? undefined}
                          className={`rounded-xl px-3 py-2.5 ${
                            owner
                              ? 'bg-sky-50 ring-1 ring-sky-100 dark:bg-sky-950/40 dark:ring-sky-900'
                              : 'bg-slate-50 ring-1 ring-slate-200 dark:bg-muted/40 dark:ring-border'
                          }`}
                        >
                          <div className="mb-2 flex flex-wrap items-center gap-1.5">
                            <span
                              className={`max-w-full truncate rounded-full px-2.5 py-0.5 text-sm font-semibold ${
                                owner
                                  ? 'bg-sky-100 text-sky-900 dark:bg-sky-900/60 dark:text-sky-100'
                                  : 'text-slate-500 dark:text-muted-foreground'
                              }`}
                            >
                              {owner ?? t('zoneBoardUnassigned')}
                            </span>
                            {backup && (
                              <span className="max-w-full truncate rounded-full bg-orange-50 px-2.5 py-0.5 text-sm font-medium text-orange-800 ring-1 ring-orange-200 dark:bg-orange-950/50 dark:text-orange-200 dark:ring-orange-900">
                                {t('zoneBoardBackup', { name: backup })}
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5">
                            {run.tables.map((table) => (
                              <div
                                key={table.id}
                                data-testid={`table-zone-board-table-${table.name}`}
                                data-table-owner={owner ?? undefined}
                                title={owner ?? t('zoneBoardUnassigned')}
                                className="flex h-11 min-w-0 items-center justify-center truncate rounded-lg bg-white px-1 text-base font-bold text-slate-800 shadow-sm ring-1 ring-slate-200 dark:bg-background dark:text-foreground dark:ring-border"
                              >
                                {table.name}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p
            className="mt-4 text-sm text-slate-600 dark:text-muted-foreground"
            data-testid="table-zone-board-summary"
          >
            {t('zoneBoardSummary', {
              zones: zones.length,
              staff: new Set(tables.map((table) => table.owner_user_id).filter(Boolean)).size,
              assigned: tables.filter((table) => table.owner_user_id).length,
              total: tables.length,
            })}
          </p>
        </>
      )}
    </section>
  );
}
