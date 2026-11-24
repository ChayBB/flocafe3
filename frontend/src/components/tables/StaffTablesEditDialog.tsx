'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { formatTableRanges } from '@/lib/table-ranges';
import type { StaffTablesDialogTable } from './StaffTablesDialog';

type Role = 'none' | 'owner' | 'backup';

export default function StaffTablesEditDialog<T>({
  member,
  tables,
  backupEnabled = true,
  onClose,
  onSaved,
}: {
  member: { id: string; name: string };
  tables: StaffTablesDialogTable[];
  backupEnabled?: boolean;
  onClose: () => void;
  onSaved: (roster: T) => void;
}) {
  const t = useTranslations('tables');
  const initialRole = (table: StaffTablesDialogTable): Role =>
    table.owner_user_id === member.id
      ? 'owner'
      : table.backup_user_id === member.id
        ? 'backup'
        : 'none';
  const [roles, setRoles] = useState<Map<string, Role>>(
    () => new Map(tables.map((table) => [table.id, initialRole(table)])),
  );
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const roleOf = (id: string): Role => roles.get(id) ?? 'none';
  const dirty = tables.some((table) => roleOf(table.id) !== initialRole(table));

  const takenFrom = new Map<string, string[]>();
  for (const table of tables) {
    if (roleOf(table.id) !== 'owner' || !table.owner_user_id || table.owner_user_id === member.id) {
      continue;
    }
    const owner = table.owner_name ?? t('staffTablesUnknownOwner');
    takenFrom.set(owner, [...(takenFrom.get(owner) ?? []), table.name]);
  }

  const setRole = (id: string, role: Role) => {
    setConfirming(false);
    setRoles((current) => new Map(current).set(id, roleOf(id) === role ? 'none' : role));
  };

  const submit = async () => {
    if (takenFrom.size > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put<T>('/tables/staff-tables/edit', {
        user_id: member.id,
        own_table_ids: tables.filter((table) => roleOf(table.id) === 'owner').map((x) => x.id),
        backup_table_ids: tables.filter((table) => roleOf(table.id) === 'backup').map((x) => x.id),
      });
      toast.success(t('staffTablesSaved'));
      onSaved(data);
    } catch {
      toast.error(t('staffTablesSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const ownerLabel = (table: StaffTablesDialogTable) => {
    const role = roleOf(table.id);
    if (role === 'owner') return member.name;
    if (table.owner_user_id === member.id) return t('staffTablesNoOwner');
    return table.owner_name ?? t('staffTablesNoOwner');
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-card text-foreground rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
        data-testid="staff-tables-edit-dialog"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-bold mb-1">
          {t('staffTablesEditTitle', { name: member.name })}
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {backupEnabled ? t('staffTablesEditHint') : t('staffTablesEditHintOwnerOnly')}
        </p>
        <div className="flex-1 overflow-y-auto space-y-1 pe-1">
          {tables.map((table) => {
            const role = roleOf(table.id);
            return (
              <div
                key={table.id}
                data-testid={`staff-tables-edit-row-${table.id}`}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
              >
                <span className="font-medium">
                  {t('staffTablesTableName', { name: table.name })}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  data-testid={`staff-tables-edit-holder-${table.id}`}
                >
                  {ownerLabel(table)}
                </span>
                {(backupEnabled ? (['owner', 'backup'] as const) : (['owner'] as const)).map(
                  (value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={role === value}
                      data-testid={`staff-tables-edit-${value}-${table.id}`}
                      onClick={() => setRole(table.id, value)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                        role === value
                          ? value === 'owner'
                            ? 'border-brand bg-brand text-white'
                            : 'border-amber-400 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {value === 'owner' ? t('staffTablesKindOwner') : t('staffTablesKindBackup')}
                    </button>
                  ),
                )}
              </div>
            );
          })}
        </div>
        {confirming && (
          <p
            className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            data-testid="staff-tables-edit-confirm"
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
            data-testid="staff-tables-edit-submit"
            onClick={submit}
            disabled={saving || !dirty}
          >
            {confirming ? t('staffTablesConfirmMove') : t('saveChanges')}
          </Button>
        </div>
      </div>
    </div>
  );
}
