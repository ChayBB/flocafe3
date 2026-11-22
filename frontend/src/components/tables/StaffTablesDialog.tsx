'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { formatTableRanges } from '@/lib/table-ranges';

export interface StaffTablesDialogTable {
  id: string;
  name: string;
  floor: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  backup_user_id: string | null;
}

type Kind = 'owner' | 'backup';

export default function StaffTablesDialog<T>({
  member,
  tables,
  onClose,
  onSaved,
}: {
  member: { id: string; name: string };
  tables: StaffTablesDialogTable[];
  onClose: () => void;
  onSaved: (roster: T) => void;
}) {
  const t = useTranslations('tables');
  const [kind, setKind] = useState<Kind>('owner');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const alreadyHeld = (table: StaffTablesDialogTable) =>
    kind === 'owner'
      ? table.owner_user_id === member.id
      : table.owner_user_id === member.id || table.backup_user_id === member.id;

  const takenFrom = new Map<string, string[]>();
  if (kind === 'owner') {
    for (const table of tables) {
      if (!selected.has(table.id) || !table.owner_user_id || table.owner_user_id === member.id) {
        continue;
      }
      const owner = table.owner_name ?? t('staffTablesUnknownOwner');
      takenFrom.set(owner, [...(takenFrom.get(owner) ?? []), table.name]);
    }
  }

  const toggle = (id: string) => {
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (takenFrom.size > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put<T>('/tables/staff-tables', {
        user_id: member.id,
        table_ids: [...selected],
        kind,
      });
      toast.success(t('staffTablesSaved'));
      onSaved(data);
    } catch {
      toast.error(t('staffTablesSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-card text-foreground rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
        data-testid="staff-tables-dialog"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-bold mb-3">{t('staffTablesTitle', { name: member.name })}</h2>
        <div className="mb-3 flex gap-1 rounded-xl bg-muted p-1" role="radiogroup">
          {(['owner', 'backup'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              data-testid={`staff-tables-kind-${value}`}
              onClick={() => {
                setKind(value);
                setSelected(new Set());
                setConfirming(false);
              }}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                kind === value ? 'bg-card shadow text-foreground' : 'text-muted-foreground'
              }`}
            >
              {value === 'owner' ? t('staffTablesKindOwner') : t('staffTablesKindBackup')}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto space-y-1 pe-1">
          {tables.map((table) => {
            const held = alreadyHeld(table);
            return (
              <label
                key={table.id}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                  held ? 'opacity-50' : 'hover:bg-muted cursor-pointer'
                }`}
              >
                <input
                  type="checkbox"
                  data-testid={`staff-tables-option-${table.id}`}
                  checked={held || selected.has(table.id)}
                  disabled={held}
                  onChange={() => toggle(table.id)}
                  className="w-4 h-4"
                />
                <span className="font-medium">
                  {t('staffTablesTableName', { name: table.name })}
                </span>
                <span className="ms-auto truncate text-xs text-muted-foreground">
                  {table.owner_name ?? t('staffTablesNoOwner')}
                </span>
              </label>
            );
          })}
        </div>
        {confirming && (
          <p
            className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            data-testid="staff-tables-confirm"
          >
            {[...takenFrom.entries()]
              .map(([owner, names]) =>
                t('staffTablesMoveConfirm', {
                  tables: formatTableRanges(names),
                  from: owner,
                  to: member.name,
                }),
              )
              .join(' ')}
          </p>
        )}
        <div className="mt-4 flex gap-2">
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
            type="button"
            className="flex-1"
            data-testid="staff-tables-submit"
            onClick={submit}
            disabled={saving || selected.size === 0}
          >
            {confirming ? t('staffTablesConfirmMove') : t('staffTablesAdd')}
          </Button>
        </div>
      </div>
    </div>
  );
}
