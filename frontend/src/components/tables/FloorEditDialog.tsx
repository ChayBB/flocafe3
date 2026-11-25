'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTableRanges } from '@/lib/table-ranges';
import type { Table } from '@/lib/types';

const inputClass =
  'w-full px-3 py-2 border border-border bg-card rounded-lg outline-none focus:ring-2 focus:ring-brand';

/** Edits one floor/zone in place: its name, each table's name and seats, and deletes tables no longer used. */
export default function FloorEditDialog({
  floor,
  tables,
  onClose,
  onSaved,
}: {
  floor: string;
  tables: Table[];
  onClose: () => void;
  onSaved: (floor: string) => void;
}) {
  const t = useTranslations('tables');
  const tCommon = useTranslations('common');
  const sorted = [...tables].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const [name, setName] = useState(floor);
  const [rows, setRows] = useState(() =>
    sorted.map((table) => ({ id: table.id, name: table.name, capacity: String(table.capacity) })),
  );
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const original = new Map(sorted.map((table) => [table.id, table]));
  const kept = rows.filter((row) => !removing.has(row.id));
  const removed = sorted.filter((table) => removing.has(table.id));
  const changed = kept.filter((row) => {
    const table = original.get(row.id)!;
    return row.name.trim() !== table.name || Number(row.capacity) !== table.capacity;
  });
  const newName = name.trim();
  const dirty = (newName && newName !== floor) || changed.length > 0 || removed.length > 0;
  const valid =
    Boolean(newName) &&
    kept.every(
      (row) =>
        row.name.trim() && Number.isInteger(Number(row.capacity)) && Number(row.capacity) >= 1,
    );

  const update = (id: string, field: 'name' | 'capacity', value: string) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));

  const toggleRemove = (id: string) =>
    setRemoving((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || !valid) return;
    setSaving(true);
    let deleteFailed = false;
    for (const table of removed) {
      try {
        await api.delete(`/tables/${table.id}`);
      } catch (error: unknown) {
        deleteFailed = true;
        const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
        toast.error(
          code === 'TABLE_HAS_ACTIVE_ORDER'
            ? t('deleteTableHasOrder', { name: table.name })
            : t('deleteTableFailed', { name: table.name }),
          { position: 'top-center' },
        );
      }
    }
    try {
      for (const row of changed) {
        await api.put(`/tables/${row.id}`, {
          number: row.name.trim(),
          capacity: Number(row.capacity),
        });
      }
      if (newName !== floor) {
        await api.patch(`/tables/floors/${encodeURIComponent(floor)}`, { newName });
      }
      if (!deleteFailed) toast.success(t('floorEdited'), { position: 'top-center' });
      onSaved(newName);
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast.error(
        code === 'TABLE_NAME_DUPLICATE' ? t('tableNameDuplicate') : t('floorEditFailed'),
        {
          position: 'top-center',
        },
      );
      onSaved(floor);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-card p-6 text-foreground shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        data-testid="floorplan-floor-edit-form"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="mb-4 text-lg font-bold">{t('editFloorTitle', { name: floor })}</h2>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label
              htmlFor="floorplan-floor-edit-name"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              {t('floorName')}
            </label>
            <input
              id="floorplan-floor-edit-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
              required
            />
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_2.75rem] gap-3 text-xs font-medium text-muted-foreground">
              <span>{t('tableName')}</span>
              <span>{t('capacity')}</span>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto pe-1">
              {rows.map((row) => {
                const table = original.get(row.id)!;
                const marked = removing.has(row.id);
                return (
                  <div
                    key={row.id}
                    data-testid={`floorplan-floor-edit-row-${table.name}`}
                    data-removing={marked ? 'true' : undefined}
                    className={`grid grid-cols-[1fr_1fr_2.75rem] items-center gap-3 ${marked ? 'opacity-50' : ''}`}
                  >
                    <div className="relative">
                      <input
                        type="text"
                        value={row.name}
                        aria-label={`${t('tableName')} ${table.name}`}
                        onChange={(event) => update(row.id, 'name', event.target.value)}
                        className={`${inputClass} ${marked ? 'line-through' : ''}`}
                        disabled={marked}
                        required
                      />
                      {!table.is_active && (
                        <span className="absolute end-2 top-1/2 -translate-y-1/2 rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                          {t('floorEditInactive')}
                        </span>
                      )}
                    </div>
                    <input
                      type="number"
                      min="1"
                      inputMode="numeric"
                      value={row.capacity}
                      aria-label={`${t('capacity')} ${table.name}`}
                      onChange={(event) => update(row.id, 'capacity', event.target.value)}
                      className={inputClass}
                      disabled={marked}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => toggleRemove(row.id)}
                      aria-label={t(marked ? 'floorEditKeepRow' : 'floorEditDeleteRow', {
                        name: table.name,
                      })}
                      data-testid={`floorplan-floor-edit-delete-${table.name}`}
                      className={`grid size-11 place-items-center rounded-lg border ${
                        marked
                          ? 'border-border text-foreground'
                          : 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950'
                      }`}
                    >
                      {marked ? <Undo2 size={18} /> : <Trash2 size={18} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          {removed.length > 0 && (
            <div
              role="alert"
              data-testid="floorplan-floor-edit-will-delete"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              <p className="font-semibold">
                {t('floorEditWillDelete', {
                  count: removed.length,
                  tables: formatTableRanges(removed.map((table) => table.name)),
                })}
              </p>
              <p className="mt-1">{t('deleteTablesHint')}</p>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={saving}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={saving || !dirty || !valid}
              data-testid="floorplan-floor-edit-submit"
            >
              {saving ? tCommon('saving') : t('saveChanges')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
