'use client';

import { useState } from 'react';
import {
  ChevronDown,
  LayoutGrid,
  Lightbulb,
  MinusCircle,
  Plus,
  UserRound,
  Users,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  formatTableRanges,
  neighbourRanges,
  resolveTableRange,
  tablesToRanges,
  type TableRange,
} from '@/lib/table-ranges';

export type RangeFormTable = {
  id: string;
  label: string;
  floor?: string | null;
  owner_user_id?: string | null;
  owner_name?: string | null;
  backup_user_id?: string | null;
};

type Kind = 'primary' | 'backup';
const MIN_ROWS: Record<Kind, number> = { primary: 1, backup: 2 };
const isBlank = (range: TableRange) => !range.from.trim() && !range.to.trim();
const blankRows = (kind: Kind, ranges: TableRange[]) => [
  ...ranges,
  ...Array.from({ length: Math.max(0, MIN_ROWS[kind] - ranges.length) }, () => ({
    from: '',
    to: '',
  })),
];

const input =
  'h-14 min-w-0 flex-1 rounded-xl border-2 bg-background px-3 text-lg outline-none placeholder:text-muted-foreground/50 focus-visible:border-orange-600';

/**
 * Typed table ranges for one staff member's main and backup tables. Staff use it for themselves;
 * a manager (`manager`) may also move main tables away from other staff after confirming.
 */
export function StaffTableRangeForm({
  tables,
  userId,
  userName,
  backupEnabled,
  saving,
  manager = false,
  title,
  onSave,
  onCancel,
}: {
  tables: RangeFormTable[];
  userId: string;
  userName?: string;
  backupEnabled: boolean;
  saving: boolean;
  manager?: boolean;
  title?: string;
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
  const [confirming, setConfirming] = useState(false);
  const [zonesOpen, setZonesOpen] = useState(false);

  const resolve = (kind: Kind) =>
    ranges[kind].map((range) => {
      const found = resolveTableRange(range, tables);
      const taken = manager
        ? []
        : found.filter((table) => {
            const holder = kind === 'primary' ? table.owner_user_id : table.backup_user_id;
            return holder != null && holder !== userId;
          });
      return { found, blank: isBlank(range), taken };
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
  const holderLine = (row: (typeof primary)[number]) => {
    const holders = [
      ...new Set(
        row.found
          .filter((table) => table.owner_user_id && table.owner_user_id !== userId)
          .map((table) => table.owner_name || t('otherStaff')),
      ),
    ];
    return holders.length ? t('rangeHolder', { names: holders.join(', ') }) : null;
  };

  const moving = tables.filter(
    (table) =>
      primaryIds.includes(table.id) && table.owner_user_id && table.owner_user_id !== userId,
  );
  const movingFrom = [
    ...moving
      .reduce((map, table) => {
        const from = table.owner_name || t('otherStaff');
        return map.set(from, [...(map.get(from) ?? []), table.label]);
      }, new Map<string, string[]>())
      .entries(),
  ];
  const unassigned = tables.filter(
    (table) =>
      !primaryIds.includes(table.id) && (!table.owner_user_id || table.owner_user_id === userId),
  );
  const zones = [
    ...new Set(tables.map((table) => table.floor?.trim()).filter((zone): zone is string => !!zone)),
  ];

  const update = (kind: Kind, index: number, field: keyof TableRange, value: string) => {
    setConfirming(false);
    setRanges((current) => ({
      ...current,
      [kind]: current[kind].map((range, i) => (i === index ? { ...range, [field]: value } : range)),
    }));
  };
  const add = (kind: Kind) =>
    setRanges((current) => ({ ...current, [kind]: [...current[kind], { from: '', to: '' }] }));
  const remove = (kind: Kind, index: number) => {
    setConfirming(false);
    setRanges((current) => ({
      ...current,
      [kind]: blankRows(
        kind,
        current[kind].filter((_, i) => i !== index),
      ),
    }));
  };
  const addZone = (zone: string) => {
    const zoneTables = tables.filter(
      (table) => table.floor?.trim() === zone && !primaryIds.includes(table.id),
    );
    const zoneRanges = tablesToRanges(zoneTables, tables);
    setZonesOpen(false);
    setRanges((current) => ({
      ...current,
      backup: blankRows('backup', [
        ...current.backup.filter((range) => !isBlank(range)),
        ...zoneRanges,
      ]),
    }));
  };

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
      {kind === 'backup' && (
        <p data-testid="staff-range-backup-hint" className="text-base text-muted-foreground">
          {t('rangeBackupHint')}
        </p>
      )}
      <div className="flex gap-3 pe-11 text-base text-muted-foreground">
        <span className="flex-1">{t('rangeFrom')}</span>
        <span className="w-4" />
        <span className="flex-1">{t('rangeTo')}</span>
      </div>
      {ranges[kind].map((range, index) => {
        const error = checked || range.to.trim() ? rowError(rows[index], range) : null;
        const holder = rows[index] && !error ? holderLine(rows[index]) : null;
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
            {holder && (
              <p
                data-testid={`staff-range-${kind}-holder`}
                className="flex items-center gap-1.5 text-base text-muted-foreground"
              >
                <UserRound size={16} aria-hidden="true" />
                {holder}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => add(kind)}
          className="flex h-12 items-center gap-2 text-base font-medium text-orange-600 dark:text-orange-400"
        >
          <Plus size={18} aria-hidden="true" />
          {kind === 'primary' ? t('addPrimaryRange') : t('addBackupRange')}
        </button>
        {kind === 'backup' && zones.length > 0 && (
          <button
            type="button"
            onClick={() => setZonesOpen((open) => !open)}
            aria-expanded={zonesOpen}
            data-testid="staff-range-pick-zone"
            className="flex h-11 items-center gap-2 rounded-xl border border-border bg-background px-3 text-base"
          >
            <Users size={18} aria-hidden="true" />
            {t('pickZone')}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {kind === 'backup' && zonesOpen && (
        <div className="flex flex-wrap gap-2" data-testid="staff-range-zones">
          {zones.map((zone) => (
            <button
              key={zone}
              type="button"
              onClick={() => addZone(zone)}
              className="h-11 rounded-full border-2 border-amber-400 bg-amber-50 px-4 text-base font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {zone}
            </button>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <section
      className="space-y-5 rounded-2xl border border-border bg-card p-4"
      data-testid="staff-table-picker"
    >
      <h2 className="flex items-center gap-2 text-xl font-bold">
        <LayoutGrid size={22} className="text-orange-600 dark:text-orange-400" aria-hidden="true" />
        {title ?? t('myTables')}
      </h2>
      {section('primary', primary, primaryIds.length)}
      {backupEnabled && (
        <>
          <hr className="border-border" />
          {section('backup', backup, backupIds.length)}
        </>
      )}
      {unassigned.length > 0 && (
        <>
          <hr className="border-border" />
          <div data-testid="staff-range-unassigned" className="flex items-start gap-3">
            <Lightbulb
              size={22}
              className="mt-0.5 shrink-0 text-orange-600 dark:text-orange-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-base font-semibold">{t('unassignedTables')}</p>
              <p className="text-base text-muted-foreground">
                {t('unassignedList', {
                  tables: formatTableRanges(unassigned.map((table) => table.label)),
                })}
              </p>
            </div>
          </div>
        </>
      )}
      <hr className="border-border" />
      <div className="flex items-center justify-between">
        <span className="text-base text-muted-foreground">{t('rangeTotal')}</span>
        <span data-testid="staff-range-total" className="text-2xl font-bold">
          {t('tableCount', { count: new Set([...primaryIds, ...backupIds]).size })}
        </span>
      </div>
      {confirming && (
        <p
          data-testid="staff-range-move-confirm"
          className="rounded-xl bg-amber-50 p-3 text-base text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {movingFrom
            .map(([from, labels]) =>
              t('moveConfirm', {
                tables: formatTableRanges(labels),
                from,
                to: userName ?? '',
              }),
            )
            .join(' ')}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-14 flex-1 items-center justify-center rounded-xl border border-border bg-background text-lg font-medium"
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          disabled={saving}
          data-testid="staff-range-save"
          onClick={() => {
            setChecked(true);
            if (errors.some(Boolean)) return;
            if (manager && moving.length > 0 && !confirming) {
              setConfirming(true);
              return;
            }
            onSave(primaryIds, backupEnabled ? backupIds : undefined);
          }}
          className="flex h-14 flex-1 items-center justify-center rounded-xl bg-orange-600 text-lg font-semibold text-white disabled:opacity-60 dark:bg-orange-500 dark:text-orange-950"
        >
          {confirming ? t('confirmMove') : t('save')}
        </button>
      </div>
    </section>
  );
}
