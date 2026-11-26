'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Pencil, Plus, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

export interface TableStaffPlan {
  id: string;
  letter: string;
  name: string;
  staff_min: number | null;
  staff_max: number | null;
  condition_note: string | null;
  auto_assign: boolean;
  table_count: number;
  zone_count: number;
  people: { id: string; name: string; part_time: boolean }[];
}

interface PlansResponse {
  plans: TableStaffPlan[];
  present_count: number;
  suggested_plan_id: string | null;
}

export interface PlanApplyResponse<R> extends PlansResponse {
  changes: unknown[];
  absent: { id: string; name: string }[];
  filled_tables: string[];
  activated_tables: string[];
  deactivated_tables: string[];
  busy_tables: string[];
  plan_id: string;
  roster: R;
}

const TILE_COLORS = [
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200',
  'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200',
];

function tileColor(letter: string): string {
  const index = Math.max(0, letter.charCodeAt(0) - 65);
  return TILE_COLORS[index % TILE_COLORS.length];
}

interface Draft {
  name: string;
  staff_min: string;
  staff_max: string;
  condition_note: string;
  auto_assign: boolean;
  resnapshot: boolean;
}

const emptyDraft: Draft = {
  name: '',
  staff_min: '',
  staff_max: '',
  condition_note: '',
  auto_assign: false,
  resnapshot: false,
};

const countOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/** Saved table assignments the manager can reuse, with one suggested from today's attendance. */
export default function TableStaffPlans<R>({
  attendanceKey,
  onApplied,
}: {
  attendanceKey: string;
  onApplied: (result: PlanApplyResponse<R>) => void;
}) {
  const t = useTranslations('tables');
  const [data, setData] = useState<PlansResponse | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [confirmApply, setConfirmApply] = useState<TableStaffPlan | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [result, setResult] = useState<PlanApplyResponse<R> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<PlansResponse>('/tables/staff-plans')
      .then((res) => setData(res.data))
      .catch(() => toast.error(t('plansLoadFailed')));
  }, [t]);

  useEffect(() => {
    load();
  }, [load, attendanceKey]);

  if (!data) return null;

  const staffText = (plan: TableStaffPlan) => {
    if (plan.staff_min === null && plan.staff_max === null) return t('plansCustomCondition');
    if (plan.staff_min !== null && plan.staff_min === plan.staff_max) {
      return t('plansStaffExact', { count: plan.staff_min });
    }
    return t('plansStaffRange', {
      min: plan.staff_min ?? 0,
      max: plan.staff_max ?? '∞',
    });
  };

  const suggested = data.plans.find((plan) => plan.id === data.suggested_plan_id) ?? null;

  const openEdit = (plan: TableStaffPlan | null) => {
    setConfirmDelete(false);
    setEditing({
      id: plan?.id ?? null,
      draft: plan
        ? {
            name: plan.name,
            staff_min: plan.staff_min === null ? '' : String(plan.staff_min),
            staff_max: plan.staff_max === null ? '' : String(plan.staff_max),
            condition_note: plan.condition_note ?? '',
            auto_assign: plan.auto_assign,
            resnapshot: false,
          }
        : emptyDraft,
    });
  };

  const draftError = (draft: Draft): string | null => {
    if (!draft.name.trim()) return t('plansNameRequired');
    const min = countOrNull(draft.staff_min);
    const max = countOrNull(draft.staff_max);
    const bad = (value: number | null) =>
      value !== null && (!Number.isInteger(value) || value < 0 || value > 999);
    if (bad(min) || bad(max)) return t('plansStaffInvalid');
    if (min !== null && max !== null && min > max) return t('plansStaffRangeInvalid');
    return null;
  };

  const saveDraft = async () => {
    if (!editing) return;
    const { id, draft } = editing;
    const body = {
      name: draft.name.trim(),
      staff_min: countOrNull(draft.staff_min),
      staff_max: countOrNull(draft.staff_max),
      condition_note: draft.condition_note.trim() || null,
      auto_assign: draft.auto_assign,
      ...(id ? { resnapshot: draft.resnapshot } : {}),
    };
    setBusy(true);
    try {
      const res = id
        ? await api.put<PlansResponse>(`/tables/staff-plans/${id}`, body)
        : await api.post<PlansResponse>('/tables/staff-plans', body);
      setData(res.data);
      setEditing(null);
      toast.success(id ? t('plansUpdated') : t('plansCreated'));
    } catch {
      toast.error(t('plansSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (plan: TableStaffPlan) => {
    try {
      const res = await api.post<PlansResponse>(`/tables/staff-plans/${plan.id}/duplicate`);
      setData(res.data);
      toast.success(t('plansDuplicated', { name: plan.name }));
    } catch {
      toast.error(t('plansSaveFailed'));
    }
  };

  const remove = async () => {
    if (!editing?.id) return;
    setBusy(true);
    try {
      const res = await api.delete<PlansResponse>(`/tables/staff-plans/${editing.id}`);
      setData(res.data);
      setEditing(null);
      toast.success(t('plansDeleted'));
    } catch {
      toast.error(t('plansSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (plan: TableStaffPlan) => {
    setBusy(true);
    try {
      const res = await api.post<PlanApplyResponse<R>>(`/tables/staff-plans/${plan.id}/apply`);
      setData(res.data);
      setConfirmApply(null);
      setResult(res.data);
      onApplied(res.data);
    } catch {
      toast.error(t('plansApplyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const appliedPlan = result ? data.plans.find((plan) => plan.id === result.plan_id) : null;

  return (
    <section
      className="w-full min-w-0 rounded-2xl border border-border bg-card p-6"
      data-testid="table-staff-plans"
    >
      <div className="mb-4">
        <h3 className="text-base font-bold text-foreground">{t('plansTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('plansSubtitle')}</p>
      </div>

      {suggested && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sky-50 px-4 py-3 ring-1 ring-sky-100 dark:bg-sky-950/40 dark:ring-sky-900"
          data-testid="table-staff-plans-suggestion"
        >
          <p className="flex items-center gap-2 text-sm text-sky-900 dark:text-sky-100">
            <Sparkles size={16} aria-hidden="true" />
            {t('plansSuggestion', {
              count: data.present_count,
              letter: suggested.letter,
              name: suggested.name,
            })}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => setConfirmApply(suggested)}
            data-testid="table-staff-plans-suggestion-apply"
          >
            {t('plansApply')}
          </Button>
        </div>
      )}

      {data.plans.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">{t('plansEmpty')}</p>
      ) : (
        <ul className="mb-3 divide-y divide-border">
          {data.plans.map((plan) => {
            const partTime = plan.people.filter((person) => person.part_time).length;
            return (
              <li
                key={plan.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                data-testid="table-staff-plan"
                data-plan-letter={plan.letter}
              >
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold ${tileColor(plan.letter)}`}
                >
                  {plan.letter}
                </span>
                <div className="min-w-[9rem] flex-1">
                  <p className="truncate font-semibold text-foreground">{plan.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {staffText(plan)}
                    {plan.auto_assign
                      ? ` · ${t('plansAutoTag')}`
                      : ` · ${t('plansPeopleCount', { count: plan.people.length })}`}
                    {partTime > 0 && ` · ${t('plansPartTimeCount', { count: partTime })}`}
                  </p>
                  {plan.condition_note && (
                    <p className="truncate text-xs text-muted-foreground">{plan.condition_note}</p>
                  )}
                </div>
                <div className="ms-auto flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmApply(plan)}
                    data-testid="table-staff-plan-apply"
                  >
                    {t('plansApply')}
                  </Button>
                  <button
                    type="button"
                    onClick={() => duplicate(plan)}
                    aria-label={t('plansDuplicate')}
                    title={t('plansDuplicate')}
                    data-testid="table-staff-plan-duplicate"
                    className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Copy size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(plan)}
                    aria-label={t('plansEdit')}
                    title={t('plansEdit')}
                    data-testid="table-staff-plan-edit"
                    className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil size={18} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => openEdit(null)}
        data-testid="table-staff-plans-add"
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-3 text-sm font-semibold text-muted-foreground hover:border-brand hover:text-foreground"
      >
        <Plus size={16} aria-hidden="true" />
        {t('plansAdd')}
      </button>

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-card p-6 text-foreground shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="table-staff-plan-dialog"
          >
            <h2 className="mb-1 text-lg font-bold">
              {editing.id ? t('plansEditTitle') : t('plansAddTitle')}
            </h2>
            {!editing.id && (
              <p className="mb-4 text-sm text-muted-foreground">{t('plansAddHint')}</p>
            )}
            <div className="space-y-3">
              <label className="block text-sm font-medium">
                {t('plansName')}
                <input
                  value={editing.draft.name}
                  maxLength={60}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })
                  }
                  data-testid="table-staff-plan-name"
                  className="mt-1 w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium">
                  {t('plansStaffMin')}
                  <input
                    inputMode="numeric"
                    value={editing.draft.staff_min}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, staff_min: e.target.value },
                      })
                    }
                    data-testid="table-staff-plan-min"
                    className="mt-1 w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                </label>
                <label className="block text-sm font-medium">
                  {t('plansStaffMax')}
                  <input
                    inputMode="numeric"
                    value={editing.draft.staff_max}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, staff_max: e.target.value },
                      })
                    }
                    data-testid="table-staff-plan-max"
                    className="mt-1 w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                </label>
              </div>
              <label className="block text-sm font-medium">
                {t('plansNote')}
                <input
                  value={editing.draft.condition_note}
                  maxLength={200}
                  placeholder={t('plansNotePlaceholder')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, condition_note: e.target.value },
                    })
                  }
                  className="mt-1 w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.draft.auto_assign}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, auto_assign: e.target.checked },
                    })
                  }
                  data-testid="table-staff-plan-auto"
                  className="mt-0.5 rounded border-gray-300 text-brand focus:ring-brand"
                />
                {t('plansAutoAssign')}
              </label>
              {editing.id && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.draft.resnapshot}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, resnapshot: e.target.checked },
                      })
                    }
                    data-testid="table-staff-plan-resnapshot"
                    className="mt-0.5 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  {t('plansResnapshot')}
                </label>
              )}
              {draftError(editing.draft) && editing.draft.name !== '' && (
                <p className="text-sm text-destructive">{draftError(editing.draft)}</p>
              )}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {editing.id &&
                (confirmDelete ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={remove}
                    disabled={busy}
                    data-testid="table-staff-plan-delete-confirm"
                  >
                    {t('plansDeleteConfirm')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirmDelete(true)}
                    data-testid="table-staff-plan-delete"
                  >
                    {t('plansDelete')}
                  </Button>
                ))}
              <div className="ms-auto flex gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
                <Button
                  type="button"
                  onClick={saveDraft}
                  disabled={busy || draftError(editing.draft) !== null}
                  data-testid="table-staff-plan-save"
                >
                  {t('saveChanges')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmApply && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmApply(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-card p-6 text-foreground shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="table-staff-plan-apply-confirm"
          >
            <h2 className="mb-1 text-lg font-bold">
              {t('plansApplyTitle', { letter: confirmApply.letter, name: confirmApply.name })}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">{t('plansApplyBody')}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setConfirmApply(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={busy}
                onClick={() => apply(confirmApply)}
                data-testid="table-staff-plan-apply-run"
              >
                {t('plansApply')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setResult(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-card p-6 text-foreground shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="table-staff-plan-result"
          >
            <h2 className="mb-3 text-lg font-bold">
              {t('plansAppliedTitle', {
                letter: appliedPlan?.letter ?? '',
                name: appliedPlan?.name ?? '',
              })}
            </h2>
            <ul className="space-y-2 text-sm">
              <li>{t('plansResultChanges', { count: result.changes.length })}</li>
              {result.absent.length > 0 && (
                <li className="text-orange-800 dark:text-orange-200">
                  {t('plansResultAbsent', {
                    names: result.absent.map((person) => person.name).join(', '),
                  })}
                </li>
              )}
              {result.filled_tables.length > 0 && (
                <li>{t('plansResultFilled', { tables: result.filled_tables.join(', ') })}</li>
              )}
              {result.activated_tables.length > 0 && (
                <li>{t('plansResultActivated', { tables: result.activated_tables.join(', ') })}</li>
              )}
              {result.deactivated_tables.length > 0 && (
                <li>
                  {t('plansResultDeactivated', { tables: result.deactivated_tables.join(', ') })}
                </li>
              )}
              {result.busy_tables.length > 0 && (
                <li className="text-orange-800 dark:text-orange-200">
                  {t('plansResultBusy', { tables: result.busy_tables.join(', ') })}
                </li>
              )}
            </ul>
            <Button
              type="button"
              className="mt-5 w-full"
              onClick={() => setResult(null)}
              data-testid="table-staff-plan-result-close"
            >
              {t('plansDone')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
