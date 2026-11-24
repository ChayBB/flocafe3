'use client';

import { useEffect, useState } from 'react';
import { Check, Hand, Pencil, Plus, RotateCw, Shuffle, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { useLocale, useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import { Toggle } from '@/components/settings/Toggle';
import { formatTableRanges } from '@/lib/table-ranges';
import StaffTablesDialog, { type StaffTablesDialogTable } from './StaffTablesDialog';
import StaffTablesEditDialog from './StaffTablesEditDialog';

type AssignmentMode = 'manual' | 'rotate_daily' | 'shuffle_interval';

interface AssignmentSettings {
  mode: AssignmentMode;
  shuffle_days: number;
  last_run: string | null;
  backup_enabled: boolean;
}

interface StaffRoster {
  business_date: string;
  staff: {
    id: string;
    name: string;
    role: string;
    present: boolean;
    tables: { id: string; name: string }[];
    backup_tables: { id: string; name: string }[];
  }[];
  tables: StaffTablesDialogTable[];
  table_count: number;
  table_count_default: number;
  table_count_custom: boolean;
  backup_enabled: boolean;
}

const SHUFFLE_DAYS_MIN = 1;
const SHUFFLE_DAYS_MAX = 365;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export default function TableStaffAssignment() {
  const t = useTranslations('tables');
  const locale = useLocale();
  const [saved, setSaved] = useState<AssignmentSettings | null>(null);
  const [roster, setRoster] = useState<StaffRoster | null>(null);
  const [mode, setMode] = useState<AssignmentMode>('manual');
  const [days, setDays] = useState('7');
  const [present, setPresent] = useState<Set<string>>(() => new Set());
  const [tableCount, setTableCount] = useState('');
  const [saving, setSaving] = useState(false);
  const [addingFor, setAddingFor] = useState<{ id: string; name: string } | null>(null);
  const [editingFor, setEditingFor] = useState<{ id: string; name: string } | null>(null);
  const [confirmMode, setConfirmMode] = useState<AssignmentMode | null>(null);
  const [backupSaving, setBackupSaving] = useState(false);

  const applyRoster = (data: StaffRoster) => {
    setRoster(data);
    setPresent(new Set(data.staff.filter((member) => member.present).map((member) => member.id)));
    setTableCount(String(data.table_count));
  };

  useEffect(() => {
    Promise.all([
      api.get<AssignmentSettings>('/tables/owner-assignment'),
      api.get<StaffRoster>('/tables/staff-roster'),
    ])
      .then(([settingsRes, rosterRes]) => {
        setSaved(settingsRes.data);
        setMode(settingsRes.data.mode);
        setDays(String(settingsRes.data.shuffle_days));
        applyRoster(rosterRes.data);
      })
      .catch(() => toast.error(t('staffAssignmentLoadFailed')));
  }, [t]);

  if (!saved || !roster) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const parsedDays = Number(days);
  const daysValid =
    Number.isInteger(parsedDays) &&
    parsedDays >= SHUFFLE_DAYS_MIN &&
    parsedDays <= SHUFFLE_DAYS_MAX;
  const parsedTables = Number(tableCount);
  const tablesValid =
    tableCount.trim() !== '' &&
    Number.isInteger(parsedTables) &&
    parsedTables >= 1 &&
    parsedTables <= roster.table_count_default;
  const savedPresent = new Set(
    roster.staff.filter((member) => member.present).map((member) => member.id),
  );
  const modeDirty =
    mode !== saved.mode || (mode === 'shuffle_interval' && parsedDays !== saved.shuffle_days);
  const rosterDirty = !sameSet(present, savedPresent) || parsedTables !== roster.table_count;
  const automatic = saved.mode !== 'manual';
  const canSave =
    (modeDirty || rosterDirty) &&
    !saving &&
    (mode !== 'shuffle_interval' || daysValid) &&
    (tablesValid || roster.table_count_default === 0);

  const staffCount = present.size;
  const servedTables = tablesValid ? parsedTables : 0;
  const base = staffCount > 0 ? Math.floor(servedTables / staffCount) : 0;
  const extra = staffCount > 0 ? servedTables % staffCount : 0;
  const average = staffCount > 0 ? Number((servedTables / staffCount).toFixed(1)) : 0;

  const businessDateLabel = new Intl.DateTimeFormat(
    locale.startsWith('th') ? 'th-TH-u-ca-gregory' : locale,
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  ).format(Date.parse(`${roster.business_date}T00:00:00Z`));

  const togglePresent = (id: string) => {
    setPresent((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const switchMode = async (value: AssignmentMode) => {
    setConfirmMode(null);
    setSaving(true);
    try {
      if (rosterDirty && (tablesValid || roster.table_count_default === 0)) {
        const { data } = await api.put<StaffRoster>('/tables/staff-roster', {
          present_user_ids: [...present],
          table_count: parsedTables === roster.table_count_default ? null : parsedTables,
        });
        applyRoster(data);
      }
      const { data } = await api.put<AssignmentSettings & { changes: number }>(
        '/tables/owner-assignment',
        {
          mode: value,
          shuffle_days: value === 'shuffle_interval' && daysValid ? parsedDays : saved.shuffle_days,
        },
      );
      setSaved(data);
      setMode(data.mode);
      setDays(String(data.shuffle_days));
      const refreshed = await api.get<StaffRoster>('/tables/staff-roster');
      setRoster(refreshed.data);
      toast.success(
        value === 'manual'
          ? t('staffAssignmentSaved')
          : t('staffAssignmentApplied', { count: data.changes }),
      );
    } catch {
      toast.error(t('staffAssignmentSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggleBackup = async (enabled: boolean) => {
    if (backupSaving) return;
    setBackupSaving(true);
    try {
      const { data } = await api.put<AssignmentSettings>('/tables/owner-assignment', {
        backup_enabled: enabled,
      });
      const refreshed = await api.get<StaffRoster>('/tables/staff-roster');
      setRoster(refreshed.data);
      // Only the value the backend stored counts; an older backend ignores the field.
      if (data.backup_enabled !== enabled || refreshed.data.backup_enabled !== enabled) {
        toast.error(t('staffBackupNotSaved'));
        return;
      }
      setSaved((current) => (current ? { ...current, backup_enabled: enabled } : data));
      toast.success(enabled ? t('staffBackupEnabledToast') : t('staffBackupDisabledToast'));
    } catch {
      toast.error(t('staffAssignmentSaveFailed'));
    } finally {
      setBackupSaving(false);
    }
  };

  const chooseMode = (value: AssignmentMode) => {
    if (saving) return;
    if (value === saved.mode) {
      setMode(value);
      return;
    }
    if (value === 'manual') {
      void switchMode(value);
      return;
    }
    setConfirmMode(value);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (modeDirty) {
        const { data } = await api.put<AssignmentSettings>('/tables/owner-assignment', {
          mode,
          shuffle_days: mode === 'shuffle_interval' ? parsedDays : saved.shuffle_days,
        });
        setSaved(data);
        setMode(data.mode);
        setDays(String(data.shuffle_days));
      }
      if (rosterDirty) {
        const { data } = await api.put<StaffRoster>('/tables/staff-roster', {
          present_user_ids: [...present],
          table_count: parsedTables === roster.table_count_default ? null : parsedTables,
        });
        applyRoster(data);
      }
      toast.success(t('staffAssignmentSaved'));
    } catch {
      toast.error(t('staffAssignmentSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const options: {
    value: AssignmentMode;
    icon: typeof Hand;
    title: string;
    description: string;
  }[] = [
    {
      value: 'manual',
      icon: Hand,
      title: t('staffAssignmentManual'),
      description: t('staffAssignmentManualHint'),
    },
    {
      value: 'rotate_daily',
      icon: RotateCw,
      title: t('staffAssignmentRotate'),
      description: t('staffAssignmentRotateHint'),
    },
    {
      value: 'shuffle_interval',
      icon: Shuffle,
      title: t('staffAssignmentShuffle'),
      description: t('staffAssignmentShuffleHint'),
    },
  ];

  return (
    <div
      className="bg-card rounded-2xl border border-border p-6 max-w-3xl"
      data-testid="table-staff-assignment"
    >
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h2 className="text-lg font-bold text-foreground">{t('staffAssignmentTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('staffAssignmentSubtitle')}</p>
        </div>
        <span
          data-testid="table-staff-assignment-status"
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            automatic
              ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${automatic ? 'bg-green-500' : 'bg-muted-foreground'}`}
          />
          {automatic ? t('staffAssignmentEnabled') : t('staffAssignmentDisabled')}
        </span>
      </div>

      <section className="mb-6" data-testid="staff-roster">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">{t('staffRosterTitle')}</h3>
          <span
            className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground"
            data-testid="staff-roster-date"
          >
            {businessDateLabel}
          </span>
        </div>
        <div className="mt-1 mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{t('staffRosterSubtitle')}</span>
          <span data-testid="staff-roster-count">
            {t('staffRosterCount', { present: present.size, total: roster.staff.length })}
          </span>
        </div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPresent(new Set(roster.staff.map((member) => member.id)))}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t('staffRosterSelectAll')}
          </button>
          <button
            type="button"
            onClick={() => setPresent(new Set())}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('staffRosterClear')}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {roster.staff.map((member) => {
            const isPresent = present.has(member.id);
            return (
              <div
                key={member.id}
                data-testid={`staff-roster-card-${member.id}`}
                className={`relative rounded-xl border p-3 transition-colors ${
                  isPresent
                    ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/40'
                    : 'border-border bg-muted/40'
                }`}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isPresent}
                  data-testid={`staff-roster-member-${member.id}`}
                  onClick={() => togglePresent(member.id)}
                  className={`flex w-full items-center gap-2 text-start ${automatic ? 'pe-8' : 'pe-16'}`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground">
                    <User size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {member.name}
                    </span>
                    <span
                      className={`flex items-center gap-1 text-xs ${
                        isPresent ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground'
                      }`}
                    >
                      {isPresent ? (
                        <Check size={12} />
                      ) : (
                        <span className="h-2.5 w-2.5 rounded-full border border-muted-foreground" />
                      )}
                      {isPresent ? t('staffRosterPresent') : t('staffRosterAbsent')}
                    </span>
                  </span>
                </button>
                <div className="absolute end-2 top-2 flex gap-1">
                  {!automatic && (
                    <button
                      type="button"
                      onClick={() => setEditingFor({ id: member.id, name: member.name })}
                      data-testid={`staff-roster-edit-${member.id}`}
                      aria-label={t('staffTablesEditFor', { name: member.name })}
                      title={t('staffTablesEdit')}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-foreground hover:bg-muted"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAddingFor({ id: member.id, name: member.name })}
                    data-testid={`staff-roster-add-${member.id}`}
                    aria-label={t('staffTablesAddFor', { name: member.name })}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-foreground hover:bg-muted"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {(member.tables.length > 0 || member.backup_tables.length > 0) && (
                  <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-xs">
                    {member.tables.length > 0 && (
                      <p data-testid={`staff-roster-tables-${member.id}`}>
                        <span className="text-muted-foreground">{t('staffTablesOwnLabel')} </span>
                        <span className="font-medium text-foreground">
                          {t('staffTablesTableName', {
                            name: formatTableRanges(member.tables.map((table) => table.name)),
                          })}
                        </span>
                      </p>
                    )}
                    {member.backup_tables.length > 0 && (
                      <p
                        data-testid={`staff-roster-backup-${member.id}`}
                        className="inline-block rounded-md border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                      >
                        {t('staffTablesBackupName', {
                          name: formatTableRanges(member.backup_tables.map((table) => table.name)),
                        })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-6" data-testid="staff-roster-tables">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {t('staffRosterTablesTitle')}
        </h3>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={roster.table_count_default}
            step={1}
            value={tableCount}
            onChange={(event) => setTableCount(event.target.value)}
            data-testid="staff-roster-table-count"
            aria-label={t('staffRosterTablesTitle')}
            aria-invalid={!tablesValid}
            className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-sm"
          />
          {t('staffRosterTablesUnit')}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{t('staffRosterTablesHint')}</p>
        {!tablesValid && roster.table_count_default > 0 && (
          <p className="mt-1 text-xs text-red-600">
            {t('staffRosterTablesInvalid', { max: roster.table_count_default })}
          </p>
        )}

        <div
          className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border p-3"
          data-testid="staff-backup-setting"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{t('staffBackupToggle')}</p>
            <p className="text-xs text-muted-foreground">{t('staffBackupToggleHint')}</p>
          </div>
          <Toggle
            value={roster.backup_enabled !== false}
            onChange={(enabled) => void toggleBackup(enabled)}
            label={t('staffBackupToggle')}
            disabled={backupSaving || saving}
            dataTestId="staff-backup-toggle"
          />
        </div>

        <div className="mt-4 rounded-xl bg-muted/50 p-4" data-testid="staff-roster-summary">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t('staffRosterEstimate')}
            </span>
            <span className="rounded-full bg-card px-2 py-0.5 text-xs text-muted-foreground">
              {t('staffRosterAuto')}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { value: staffCount, label: t('staffRosterStaffUnit'), id: 'staff' },
              { value: servedTables, label: t('staffRosterTablesUnit'), id: 'tables' },
              { value: average, label: t('staffRosterAverageUnit'), id: 'average' },
            ].map((figure) => (
              <div key={figure.id} className="rounded-lg bg-card p-3">
                <div
                  className="text-xl font-bold text-foreground"
                  data-testid={`staff-roster-summary-${figure.id}`}
                >
                  <Ltr>{figure.value}</Ltr>
                </div>
                <div className="text-xs text-muted-foreground">{figure.label}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-foreground" data-testid="staff-roster-split">
            {staffCount === 0
              ? t('staffRosterSplitNobody')
              : extra === 0
                ? t('staffRosterSplitEven', { staff: staffCount, tables: base })
                : t('staffRosterSplit', {
                    lowStaff: staffCount - extra,
                    lowTables: base,
                    highStaff: extra,
                    highTables: base + 1,
                  })}
          </p>
        </div>
      </section>

      <h3 className="text-sm font-semibold text-foreground mb-3">
        {t('staffAssignmentModeHeading')}
      </h3>
      <div className="space-y-3" role="radiogroup" aria-label={t('staffAssignmentModeHeading')}>
        {options.map(({ value, icon: Icon, title, description }) => {
          const selected = mode === value;
          return (
            <div
              key={value}
              className={`rounded-xl border transition-colors ${
                selected ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/50'
              }`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`staff-assignment-mode-${value}`}
                onClick={() => chooseMode(value)}
                className="w-full flex items-center gap-3 p-4 text-start"
              >
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    selected ? 'bg-brand text-white' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">{title}</span>
                  <span className="block text-xs text-muted-foreground">{description}</span>
                </span>
                <span
                  className={`h-4 w-4 shrink-0 rounded-full border-2 ${
                    selected ? 'border-brand bg-brand' : 'border-border'
                  }`}
                />
              </button>
              {value === 'shuffle_interval' && selected && (
                <label className="flex items-center gap-2 px-4 pb-4 text-sm text-foreground">
                  {t('staffAssignmentShuffleEvery')}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={SHUFFLE_DAYS_MIN}
                    max={SHUFFLE_DAYS_MAX}
                    step={1}
                    value={days}
                    onChange={(event) => setDays(event.target.value)}
                    data-testid="staff-assignment-shuffle-days"
                    aria-invalid={!daysValid}
                    className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                  />
                  {t('staffAssignmentDays')}
                </label>
              )}
            </div>
          );
        })}
      </div>

      {mode === 'shuffle_interval' && !daysValid && (
        <p className="mt-2 text-xs text-red-600">
          {t('staffAssignmentDaysInvalid', { min: SHUFFLE_DAYS_MIN, max: SHUFFLE_DAYS_MAX })}
        </p>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        {mode === 'manual' ? t('staffAssignmentManualNote') : t('staffAssignmentAutoNote')}
      </p>
      {automatic && saved.last_run && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('staffAssignmentLastRun')} <Ltr>{saved.last_run}</Ltr>
        </p>
      )}
      {confirmMode && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setConfirmMode(null)}
        >
          <div
            className="bg-card text-foreground rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            data-testid="staff-assignment-confirm"
            role="dialog"
            aria-modal="true"
          >
            <h2 className="text-lg font-bold mb-1">
              {confirmMode === 'rotate_daily'
                ? t('staffAssignmentRotate')
                : t('staffAssignmentShuffle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {t('staffAssignmentConfirmRun', { count: present.size })}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setConfirmMode(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                className="flex-1"
                data-testid="staff-assignment-confirm-run"
                onClick={() => switchMode(confirmMode)}
              >
                {t('staffAssignmentConfirmRunButton')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {editingFor && (
        <StaffTablesEditDialog<StaffRoster>
          member={editingFor}
          tables={roster.tables}
          backupEnabled={roster.backup_enabled !== false}
          onClose={() => setEditingFor(null)}
          onSaved={(data) => {
            setRoster(data);
            setEditingFor(null);
          }}
        />
      )}
      {addingFor && (
        <StaffTablesDialog<StaffRoster>
          member={addingFor}
          tables={roster.tables}
          backupEnabled={roster.backup_enabled !== false}
          onClose={() => setAddingFor(null)}
          onSaved={(data) => {
            setRoster(data);
            setAddingFor(null);
          }}
        />
      )}
      <div className="mt-5 flex justify-end">
        <Button
          type="button"
          onClick={save}
          disabled={!canSave}
          data-testid="staff-assignment-save"
        >
          {saving ? t('staffAssignmentSaving') : t('saveChanges')}
        </Button>
      </div>
    </div>
  );
}
