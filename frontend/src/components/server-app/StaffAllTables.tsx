'use client';

import { useState } from 'react';
import { LayoutGrid, Utensils } from 'lucide-react';
import { useTranslations } from 'use-intl';

export type AllTablesEntry = {
  id: string;
  name?: string;
  number?: string;
  floor?: string | null;
  owner_user_id?: string | null;
  owner_name?: string | null;
};

const label = (table: AllTablesEntry) => String(table.name ?? table.number ?? '');
const byLabel = (a: AllTablesEntry, b: AllTablesEntry) =>
  label(a).localeCompare(label(b), undefined, { numeric: true });

/** Every table filed by zone: free ones white, taken ones green with the staff member who holds them. */
export function StaffAllTables({
  tables,
  userId,
  onTable,
}: {
  tables: AllTablesEntry[];
  userId: string;
  onTable: (id: string) => void;
}) {
  const t = useTranslations('staffProfile');
  const zones = [
    ...tables
      .reduce((map, table) => {
        const zone = table.floor?.trim() ?? '';
        map.set(zone, [...(map.get(zone) ?? []), table]);
        return map;
      }, new Map<string, AllTablesEntry[]>())
      .entries(),
  ]
    .map(([zone, list]) => ({ zone, list: list.sort(byLabel) }))
    .sort((a, b) => (a.zone ? 0 : 1) - (b.zone ? 0 : 1) || byLabel(a.list[0], b.list[0]));
  const mine = zones.findIndex(({ list }) => list.some((table) => table.owner_user_id === userId));
  const [tab, setTab] = useState(Math.max(0, mine));
  const active = zones[Math.min(tab, zones.length - 1)];

  return (
    <section
      data-testid="staff-all-tables"
      className="space-y-4 rounded-2xl border border-border bg-card p-4"
    >
      <h2 className="flex items-center gap-2 text-xl font-bold">
        <LayoutGrid size={22} className="text-orange-600 dark:text-orange-400" aria-hidden="true" />
        {t('viewAllTables')}
      </h2>
      {!active ? (
        <p className="text-lg text-muted-foreground">{t('noTables')}</p>
      ) : (
        <>
          <div role="tablist" className="flex gap-1 overflow-x-auto border-b-2 border-green-600">
            {zones.map(({ zone, list }, index) => {
              const selected = index === zones.indexOf(active);
              // A zone nobody has taken yet stays white, like its free tables.
              const free = list.every((table) => !table.owner_user_id);
              const tone = free
                ? selected
                  ? 'border-gray-500 bg-white text-gray-900 ring-1 ring-gray-500'
                  : 'border-gray-200 bg-white text-gray-600'
                : selected
                  ? 'border-green-600 bg-green-600 text-white'
                  : 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300';
              return (
                <button
                  key={zone || '-'}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-zone-free={free ? 'true' : undefined}
                  onClick={() => setTab(index)}
                  className={`shrink-0 rounded-t-lg border border-b-0 px-4 py-2 text-base font-semibold ${tone}`}
                >
                  {zone || t('noZone')}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {active.list.map((table) => {
              const taken = Boolean(table.owner_user_id);
              return (
                <button
                  key={table.id}
                  type="button"
                  onClick={() => onTable(table.id)}
                  data-table-owner={taken ? (table.owner_name ?? '') : undefined}
                  className={`flex min-h-20 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border-2 px-1 py-2 ${
                    taken
                      ? 'border-green-600 bg-[#EEF8F1] dark:border-green-500 dark:bg-green-950/40'
                      : 'border-border bg-white dark:bg-background'
                  }`}
                >
                  <Utensils
                    size={20}
                    className={
                      taken ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'
                    }
                    aria-hidden="true"
                  />
                  <span className="max-w-full break-words text-center text-lg font-bold leading-tight">
                    {t('tableName', { name: label(table) })}
                  </span>
                  <span
                    className={`max-w-full truncate text-sm ${taken ? 'font-semibold text-green-800 dark:text-green-300' : 'text-muted-foreground'}`}
                  >
                    {taken ? (table.owner_name ?? '—') : t('tableAvailable')}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
