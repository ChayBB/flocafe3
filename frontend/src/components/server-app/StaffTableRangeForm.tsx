'use client';

import { useState } from 'react';
import { LayoutGrid, MinusCircle, Plus } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  neighbourRanges,
  resolveTableRange,
  tablesToRanges,
  type TableRange,
} from '@/lib/table-ranges';

export type RangeFormTable = {
  id: string;
  label: string;
  owner_user_id?: string | null;
  backup_user_id?: string | null;
};

type Kind = 'primary' | 'backup';
const MIN_ROWS: Record<Kind, number> = { primary: 1, backup: 2 };
const blankRows = (kind: Kind, ranges: TableRange[]) => [
  ...ranges,
  ...Array.from({ length: Math.max(0, MIN_ROWS[kind] - ranges.length) }, () => ({
    from: '',
    to: '',
  })),
];

const input =
  'h-14 min-w-0 flex-1 rounded-xl border-2 bg-background px-3 text-lg outline-none placeholder:text-muted-foreground/50 focus-visible:border-orange-600';

export function StaffTableRangeForm({
  tables,
  userId,
  backupEnabled,
  saving,
  onSave,
  onCancel,
}: {
  tables: RangeFormTable[];
  userId: string;
  backupEnabled: boolean;
  saving: boolean;
  onSave: (tableIds: string[], backupTableIds: string[] | undefined) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('staffProfile');
  const initial = (kind: Kind, mine: (table: RangeFormTable) => boolean) =>
    blankRows(kind, tablesToRanges(tables.filter(mine), tables));

  const [ranges, setRanges] = useState<Record<Kind, TableRange[]>>(() => ({
    primary: initial('primary', (table) => table.owner_user_id === userId),
    backup: initial(
      'backup',
      (table) => table.owner_user_id !== userId && table.backup_user_id === userId,
    ),
  }));
  const [checked, setChecked] = useState(false);

  const resolve = (kind: Kind) =>
    ranges[kind].map((range) => {
      const found = resolveTableRange(range, tables);
      const blank = !range.from.trim() && !range.to.trim();
      const taken = found.filter((table) => {
        const holder = kind === 'primary' ? table.owner_user_id : table.backup_user_id;
        return holder != null && holder !== userId;
      });
      return { found, blank, taken };
    });
  const primary = resolve('primary');
  const backup = backupEnabled ? resolve('backup') : [];
  const ids = (rows: typeof primary) => [
    ...new Set(rows.flatMap((row) => row.found.map((table) => table.id))),
  ];
  const primaryIds = ids(primary);
  const backupIds = ids(backup);
  const neighbours = neighbourRanges(
    tables.filter((table) => primaryIds.includes(table.id)),
    tables,
  );
  const guide = (kind: Kind, index: number) =>
    kind === 'backup' ? [neighbours.before, neighbours.after][index] : undefined;
  const overlap = new Set(primaryIds.filter((id) => backupIds.includes(id)));
  const names = (list: RangeFormTable[]) => list.map((table) => table.label).join(', ');
  const rowError = (row: (typeof primary)[number], range: TableRange) => {
    if (row.blank) return null;
    if (!row.found.length)
      return t('rangeNotFound', { range: [range.from, range.to].filter(Boolean).join('–') });
    if (row.taken.length) return t('rangeTaken', { tables: names(row.taken) });
    const both = row.found.filter((table) => overlap.has(table.id));
    return both.length ? t('rangeOverlap', { tables: names(both) }) : null;
  };
  const errors = [
    ...primary.map((row, i) => rowError(row, ranges.primary[i])),
    ...backup.map((row, i) => rowError(row, ranges.backup[i])),
  ];

  const update = (kind: Kind, index: number, field: keyof TableRange, value: string) =>
    setRanges((current) => ({
      ...current,
      [kind]: current[kind].map((range, i) => (i === index ? { ...range, [field]: value } : range)),
    }));
  const add = (kind: Kind) =>
    setRanges((current) => ({ ...current, [kind]: [...current[kind], { from: '', to: '' }] }));
  const remove = (kind: Kind, index: number) =>
    setRanges((current) => ({
      ...current,
      [kind]: blankRows(
        kind,
        current[kind].filter((_, i) => i !== index),
      ),
    }));

  const section = (kind: Kind, rows: typeof primary, count: number) => (
    <section data-testid={`staff-range-${kind}`} className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold">
          {kind === 'primary' ? t('rangePrimary') : t('rangeBackup')}
        </h3>
        <span
          className={`text-base ${kind === 'primary' ? 'text-orange-600 dark:text-orange-400' : 'text-muted-foreground'}`}
        >
          {t('tableCount', { count })}
        </span>
      </div>
      <div className="flex gap-3 pe-11 text-base text-muted-foreground">
        <span className="flex-1">{t('rangeFrom')}</span>
        <span className="w-4" />
        <span className="flex-1">{t('rangeTo')}</span>
      </div>
      {ranges[kind].map((range, index) => {
        const error = checked || range.to.trim() ? rowError(rows[index], range) : null;
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-3">
              <input
                value={range.from}
                placeholder={guide(kind, index)?.from}
                onChange={(event) => update(kind, index, 'from', event.target.value)}
                inputMode="numeric"
                aria-label={`${kind === 'primary' ? t('rangePrimary') : t('rangeBackup')} ${index + 1} ${t('rangeFrom')}`}
                className={`${input} ${error ? 'border-red-500' : kind === 'primary' && range.from ? 'border-orange-600 dark:border-orange-400' : 'border-border'}`}
              />
              <span className="w-4 text-center text-muted-foreground">–</span>
              <input
                value={range.to}
                placeholder={guide(kind, index)?.to}
                onChange={(event) => update(kind, index, 'to', event.target.value)}
                inputMode="numeric"
                aria-label={`${kind === 'primary' ? t('rangePrimary') : t('rangeBackup')} ${index + 1} ${t('rangeTo')}`}
                className={`${input} ${error ? 'border-red-500' : kind === 'primary' && range.to ? 'border-orange-600 dark:border-orange-400' : 'border-border'}`}
              />
              <button
                type="button"
                onClick={() => remove(kind, index)}
                aria-label={t('removeRange')}
                className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
              >
                <MinusCircle size={22} aria-hidden="true" />
              </button>
            </div>
            {error && (
              <p role="alert" className="text-base text-red-600">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => add(kind)}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-background text-base font-medium text-orange-600 dark:text-orange-400"
      >
        <Plus size={18} aria-hidden="true" />
        {kind === 'primary' ? t('addPrimaryRange') : t('addBackupRange')}
      </button>
    </section>
  );

  return (
    <section
      className="space-y-5 rounded-2xl border border-border bg-card p-4"
      data-testid="staff-table-picker"
    >
      <h2 className="flex items-center gap-2 text-xl font-bold">
        <LayoutGrid size={22} className="text-orange-600 dark:text-orange-400" aria-hidden="true" />
        {t('myTables')}
      </h2>
      {section('primary', primary, primaryIds.length)}
      {backupEnabled && (
        <>
          <hr className="border-border" />
          {section('backup', backup, backupIds.length)}
        </>
      )}
      <hr className="border-border" />
      <div className="flex items-center justify-between">
        <span className="text-base text-muted-foreground">{t('rangeTotal')}</span>
        <span data-testid="staff-range-total" className="text-2xl font-bold">
          {t('tableCount', { count: new Set([...primaryIds, ...backupIds]).size })}
        </span>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setChecked(true);
          if (errors.some(Boolean)) return;
          onSave(primaryIds, backupEnabled ? backupIds : undefined);
        }}
        className="flex h-14 w-full items-center justify-center rounded-xl bg-orange-600 text-lg font-semibold text-white disabled:opacity-60 dark:bg-orange-500 dark:text-orange-950"
      >
        {t('save')}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="w-full text-center text-base font-medium text-muted-foreground underline"
      >
        {t('cancel')}
      </button>
    </section>
  );
}
