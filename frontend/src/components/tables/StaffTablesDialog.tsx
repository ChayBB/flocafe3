'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
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

const STAFF_BADGE_TONES = [
  'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  'bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-200',
  'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200',
] as const;

/** The same staff member keeps the same badge colour every time the dialog opens. */
function staffBadgeTone(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return STAFF_BADGE_TONES[Math.abs(hash) % STAFF_BADGE_TONES.length];
}

export default function StaffTablesDialog<T>({
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
  const [chosenKind, setKind] = useState<Kind>('owner');
  const kind: Kind = backupEnabled ? chosenKind : 'owner';
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
        {backupEnabled && (
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
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  kind === value
                    ? 'bg-brand text-white shadow'
                    : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                }`}
              >
                {value === 'owner' ? t('staffTablesKindOwner') : t('staffTablesKindBackup')}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto space-y-1 pe-1">
          {tables.map((table) => {
            const held = alreadyHeld(table);
            const picked = selected.has(table.id);
            return (
              <label
                key={table.id}
                data-testid={`staff-tables-row-${table.id}`}
                data-selected={picked ? 'true' : undefined}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors ${
                  held
                    ? 'border-transparent bg-brand-light/60'
                    : picked
                      ? 'cursor-pointer border-brand/40 bg-brand-light'
                      : 'cursor-pointer border-transparent hover:bg-muted'
                }`}
              >
                <input
                  type="checkbox"
                  data-testid={`staff-tables-option-${table.id}`}
                  checked={held || picked}
                  disabled={held}
                  onChange={() => toggle(table.id)}
                  className="h-4 w-4 shrink-0 accent-brand disabled:cursor-not-allowed"
                />
                <span className={`font-medium ${held ? 'text-muted-foreground' : ''}`}>
                  {t('staffTablesTableName', { name: table.name })}
                </span>
                {held ? (
                  <span className="ms-auto inline-flex max-w-[45%] items-center gap-1 truncate rounded-full bg-brand px-2 py-0.5 text-xs font-medium text-white">
                    <Check size={12} aria-hidden="true" className="shrink-0" />
                    {member.name}
                  </span>
                ) : table.owner_user_id ? (
                  <span
                    data-testid={`staff-tables-owner-${table.id}`}
                    className={`ms-auto max-w-[45%] truncate rounded-full px-2 py-0.5 text-xs font-medium ${staffBadgeTone(table.owner_user_id)}`}
                  >
                    {table.owner_name ?? t('staffTablesUnknownOwner')}
                  </span>
                ) : (
                  <span className="ms-auto truncate rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {t('staffTablesNoOwner')}
                  </span>
                )}
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
            className="flex-1 bg-brand text-white hover:bg-brand-hover"
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
