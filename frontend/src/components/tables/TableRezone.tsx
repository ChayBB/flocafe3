'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

type RezoneTable = { id: string; name: string; floor: string | null };

const byName = (a: RezoneTable, b: RezoneTable) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });
const zoneName = (list: RezoneTable[]) =>
  [...new Set([list[0].name, list[list.length - 1].name])].join('-');

const field =
  'w-24 rounded-lg border border-border bg-background px-2 py-1 text-sm aria-[invalid=true]:border-red-500';

/** Splits the tables into one run of neighbouring tables per staff member and renames the floor-plan zones to match. */
export default function TableRezone({
  tables,
  defaultStaff,
  onRezoned,
}: {
  tables: RezoneTable[];
  defaultStaff: number;
  onRezoned: () => void;
}) {
  const t = useTranslations('tables');
  const sorted = [...tables].sort(byName);
  const [staff, setStaff] = useState(String(Math.max(1, defaultStaff)));
  const [perStaff, setPerStaff] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const staffNumber = Number(staff);
  const staffValid = Number.isInteger(staffNumber) && staffNumber >= 1;
  const suggested = staffValid ? Math.max(1, Math.ceil(sorted.length / staffNumber)) : 0;
  const perNumber = perStaff.trim() === '' ? suggested : Number(perStaff);
  const perValid = Number.isInteger(perNumber) && perNumber >= 1;
  const proposed: RezoneTable[][] = [];
  if (staffValid && perValid) {
    for (let i = 0; i < sorted.length; i += perNumber)
      proposed.push(sorted.slice(i, i + perNumber));
  }
  const current = [
    ...sorted
      .reduce((map, table) => {
        const zone = table.floor?.trim() ?? '';
        return map.set(zone, [...(map.get(zone) ?? []), table]);
      }, new Map<string, RezoneTable[]>())
      .entries(),
  ];
  const unchanged = proposed.every((list) =>
    list.every((table) => (table.floor?.trim() ?? '') === zoneName(list)),
  );

  const apply = async () => {
    setSaving(true);
    try {
      await api.put('/tables/zones', {
        zones: proposed.map((list) => ({
          name: zoneName(list),
          table_ids: list.map((table) => table.id),
        })),
      });
      toast.success(t('rezoneDone'));
      setConfirming(false);
      onRezoned();
    } catch {
      toast.error(t('rezoneFailed'));
    } finally {
      setSaving(false);
    }
  };

  const chip = (label: string, count: number, testId: string) => (
    <span
      key={label}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground"
    >
      {label}
      <span className="text-muted-foreground">{t('rezoneTableCount', { count })}</span>
    </span>
  );

  return (
    <div className="mt-4 rounded-xl border border-border p-4" data-testid="table-rezone">
      <p className="text-sm font-semibold text-foreground">{t('rezoneTitle')}</p>
      <div className="mt-3 flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('rezoneStaff')}
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={staff}
            onChange={(event) => {
              setStaff(event.target.value);
              setPerStaff('');
              setConfirming(false);
            }}
            aria-invalid={!staffValid}
            data-testid="table-rezone-staff"
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('rezonePerStaff')}
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={perStaff}
            placeholder={suggested ? String(suggested) : undefined}
            onChange={(event) => {
              setPerStaff(event.target.value);
              setConfirming(false);
            }}
            aria-invalid={!perValid}
            data-testid="table-rezone-per-staff"
            className={field}
          />
        </label>
      </div>

      <p className="mt-4 mb-2 text-xs font-semibold text-muted-foreground">{t('rezoneCurrent')}</p>
      <div className="flex flex-wrap gap-2">
        {current.map(([zone, list]) =>
          chip(zone || t('rezoneNoZone'), list.length, 'table-rezone-current'),
        )}
      </div>

      <p className="mt-4 mb-2 text-xs font-semibold text-muted-foreground">{t('rezoneProposed')}</p>
      <div className="flex flex-wrap gap-2">
        {proposed.map((list) => chip(zoneName(list), list.length, 'table-rezone-proposed'))}
      </div>

      {confirming && (
        <p
          className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="table-rezone-confirm"
        >
          {t('rezoneConfirm', { count: proposed.length })}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {confirming && (
          <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
            {t('cancel')}
          </Button>
        )}
        <Button
          type="button"
          data-testid="table-rezone-apply"
          disabled={saving || proposed.length === 0 || unchanged}
          onClick={() => (confirming ? void apply() : setConfirming(true))}
        >
          {confirming ? t('rezoneConfirmButton') : t('rezoneApply')}
        </Button>
      </div>
    </div>
  );
}
