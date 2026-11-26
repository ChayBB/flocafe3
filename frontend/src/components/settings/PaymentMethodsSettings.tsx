'use client';

import { useEffect, useRef, useState } from 'react';
import { CreditCard, Plus, Save, Trash2, Merge } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import {
  BUILT_IN_PAYMENT_SETTING,
  isBankAccountMethod,
  type BuiltInPaymentKey,
  type CustomPaymentMethod,
} from '@/lib/payment-methods';

interface PromptPayAccount {
  account: string;
  name: string;
}

interface MergeRecord {
  id: number;
  source_name: string;
  target_name: string;
  affected_payments: number;
  merged_at: string;
}

export function PaymentMethodsSettings({
  isAdmin,
  canManagePaymentMethods = isAdmin,
}: {
  isAdmin: boolean;
  canManagePaymentMethods?: boolean;
}) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const { formatDate } = useFormatDate();

  const builtInMethods = [
    { key: 'cash', labelKey: 'methodCash' },
    { key: 'card', labelKey: 'methodCard' },
    { key: 'wallet', labelKey: 'loyaltyWallet' },
  ] as const;
  const [builtInEnabled, setBuiltInEnabled] = useState<Record<BuiltInPaymentKey, boolean>>({
    cash: true,
    card: true,
    wallet: true,
  });
  const [methods, setMethods] = useState<CustomPaymentMethod[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [newName, setNewName] = useState('');
  const [mergeTargets, setMergeTargets] = useState<Record<number, string>>({});
  const [merges, setMerges] = useState<MergeRecord[]>([]);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);
  const [promptPaySaved, setPromptPaySaved] = useState<Record<number, PromptPayAccount>>({});
  const [promptPayDrafts, setPromptPayDrafts] = useState<Record<number, PromptPayAccount>>({});
  const [billQrMethodId, setBillQrMethodId] = useState<number | null>(null);
  const [bankAccount, setBankAccount] = useState('');
  const [bankAccountSaved, setBankAccountSaved] = useState('');
  const [requireOpenShift, setRequireOpenShift] = useState(false);
  const [oneShiftPerStaff, setOneShiftPerStaff] = useState(false);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(false);
  const [cardTransactionSettingState, setCardTransactionSettingState] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [isSavingCardTransactionIdRequired, setIsSavingCardTransactionIdRequired] = useState(false);
  const cardTransactionSaveEpochRef = useRef(0);
  const cardTransactionSaveInFlightRef = useRef(false);

  const loadCardTransactionSetting = async () => {
    if (cardTransactionSaveInFlightRef.current) return;
    const epoch = cardTransactionSaveEpochRef.current;
    setCardTransactionSettingState('loading');
    try {
      const cardTransactionRes = await api.get('/settings/card_transaction_id_required');
      if (cardTransactionSaveInFlightRef.current || epoch !== cardTransactionSaveEpochRef.current) {
        return;
      }
      setCardTransactionIdRequired(cardTransactionRes.data?.setting?.value === 'true');
      setCardTransactionSettingState('ready');
    } catch {
      if (cardTransactionSaveInFlightRef.current || epoch !== cardTransactionSaveEpochRef.current) {
        return;
      }
      setCardTransactionSettingState('error');
    }
  };

  const load = async () => {
    const [
      methodsRes,
      historyRes,
      splitRes,
      requireShiftRes,
      perStaffShiftRes,
      promptPayRes,
      bankRes,
    ] = await Promise.all([
      api.get('/payment-methods?include_inactive=true'),
      canManagePaymentMethods
        ? api.get('/payment-methods/merge-history').catch(() => ({ data: { merges: [] } }))
        : Promise.resolve({ data: { merges: [] } }),
      api
        .get('/settings/split_checks_enabled')
        .catch(() => ({ data: { setting: { value: 'false' } } })),
      api
        .get('/settings/require_open_shift')
        .catch(() => ({ data: { setting: { value: 'false' } } })),
      api
        .get('/settings/one_shift_per_staff')
        .catch(() => ({ data: { setting: { value: 'false' } } })),
      api
        .get('/payment-methods/promptpay-accounts')
        .catch(() => ({ data: { accounts: [], bill_method_id: null } })),
      api.get('/payment-methods/bank-qr-account').catch(() => ({ data: { account: '' } })),
      loadCardTransactionSetting(),
    ]);
    const promptPay: Record<number, PromptPayAccount> = Object.fromEntries(
      (promptPayRes.data?.accounts || []).map(
        (row: { method_id: number; account: string; name: string }) => [
          row.method_id,
          { account: row.account || '', name: row.name || '' },
        ],
      ),
    );
    setPromptPaySaved(promptPay);
    setPromptPayDrafts(promptPay);
    setBillQrMethodId(promptPayRes.data?.bill_method_id ?? null);
    setBankAccount(bankRes.data?.account || '');
    setBankAccountSaved(bankRes.data?.account || '');
    const rows = methodsRes.data.payment_methods || [];
    setMethods(rows);
    setNames(Object.fromEntries(rows.map((row: CustomPaymentMethod) => [row.id, row.name])));
    setMerges(historyRes.data.merges || []);
    setSplitChecksEnabled(splitRes.data?.setting?.value === 'true');
    setRequireOpenShift(requireShiftRes.data?.setting?.value === 'true');
    setOneShiftPerStaff(perStaffShiftRes.data?.setting?.value === 'true');
  };

  useEffect(() => {
    let active = true;
    for (const key of Object.keys(BUILT_IN_PAYMENT_SETTING) as BuiltInPaymentKey[]) {
      api
        .get(`/settings/${BUILT_IN_PAYMENT_SETTING[key]}`)
        .then((res) => {
          if (active)
            setBuiltInEnabled((current) => ({
              ...current,
              [key]: res.data?.setting?.value !== 'false',
            }));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);

  const toggleBuiltIn = async (key: BuiltInPaymentKey, enabled: boolean) => {
    setBuiltInEnabled((current) => ({ ...current, [key]: enabled }));
    try {
      await api.put(`/settings/${BUILT_IN_PAYMENT_SETTING[key]}`, { value: String(enabled) });
    } catch {
      setBuiltInEnabled((current) => ({ ...current, [key]: !enabled }));
      toast.error(t('saveFailed'));
    }
  };

  useEffect(() => {
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => toast.error(t('loadFailed')));
  }, []); // oxlint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!canManagePaymentMethods) return;
    if (!newName.trim()) return;
    try {
      await api.post('/payment-methods', { name: newName });
      setNewName('');
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const update = async (method: CustomPaymentMethod, changes: Record<string, unknown>) => {
    if (!canManagePaymentMethods) return;
    try {
      await api.put(`/payment-methods/${method.id}`, changes);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const setPromptPayDraft = (methodId: number, changes: Partial<PromptPayAccount>) =>
    setPromptPayDrafts((old) => ({
      ...old,
      [methodId]: { ...(old[methodId] ?? { account: '', name: '' }), ...changes },
    }));

  const savePromptPay = async (methodId: number, field: keyof PromptPayAccount) => {
    try {
      const { data } = await api.put(`/payment-methods/promptpay-accounts/${methodId}`, {
        [field]: promptPayDrafts[methodId]?.[field] ?? '',
      });
      const saved = { account: data.account?.account ?? '', name: data.account?.name ?? '' };
      setPromptPaySaved((old) => ({ ...old, [methodId]: saved }));
      setPromptPayDraft(methodId, { [field]: saved[field] });
      toast.success(t(field === 'account' ? 'qrAccountSaved' : 'qrAccountNameSaved'));
    } catch {
      toast.error(t(field === 'account' ? 'qrAccountInvalid' : 'saveFailed'));
    }
  };

  const promptPayMethodIds = Object.keys(promptPaySaved)
    .map(Number)
    .sort((a, b) => a - b);
  const effectiveBillQrMethodId =
    billQrMethodId !== null && promptPayMethodIds.includes(billQrMethodId)
      ? billQrMethodId
      : (promptPayMethodIds[0] ?? null);

  const saveBillQrMethod = async (methodId: number) => {
    try {
      const { data } = await api.put('/payment-methods/promptpay-bill-method', {
        method_id: methodId,
      });
      setBillQrMethodId(data.bill_method_id ?? null);
      toast.success(t('billQrMethodSaved'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const saveBankAccount = async () => {
    try {
      const { data } = await api.put('/payment-methods/bank-qr-account', { account: bankAccount });
      setBankAccount(data.account);
      setBankAccountSaved(data.account);
      toast.success(t('bankQrAccountSaved'));
    } catch {
      toast.error(t('bankQrAccountInvalid'));
    }
  };

  const remove = async (method: CustomPaymentMethod) => {
    if (!canManagePaymentMethods) return;
    if (!window.confirm(t('deletePaymentMethodConfirm'))) return;
    try {
      await api.delete(`/payment-methods/${method.id}`);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const merge = async (method: CustomPaymentMethod) => {
    if (!canManagePaymentMethods) return;
    const target = mergeTargets[method.id];
    if (!target) return;
    if (!window.confirm(t('mergePaymentMethodConfirm'))) return;
    try {
      await api.post(
        `/payment-methods/${method.id}/merge`,
        target === 'card'
          ? { target_type: 'card' }
          : { target_type: 'custom', target_id: Number(target) },
      );
      await load();
      toast.success(t('paymentMethodMerged'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  return (
    <SettingsTabShell>
      <div
        data-setting-section="payment-methods"
        className="bg-card rounded-xl border border-border p-6"
      >
        <div className="flex items-center gap-2 mb-2">
          <CreditCard size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('paymentMethods')}</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-5">{t('paymentMethodsHint')}</p>
        <div className="rounded-lg border border-border divide-y">
          {builtInMethods.map((method) => (
            <div
              key={method.key}
              className="px-3 py-2 flex items-center justify-between gap-3 text-sm"
            >
              <span className={builtInEnabled[method.key] ? '' : 'text-muted-foreground'}>
                {tPos(method.labelKey)}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-gray-400">{t('builtIn')}</span>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    className="size-5"
                    aria-label={tPos(method.labelKey)}
                    disabled={!isAdmin}
                    checked={builtInEnabled[method.key]}
                    onChange={(e) => void toggleBuiltIn(method.key, e.target.checked)}
                    data-testid={`builtin-payment-${method.key}`}
                  />{' '}
                  {t('active')}
                </label>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-5 space-y-3">
          {methods.map((method) => (
            <div key={method.id} className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <input
                  disabled={!canManagePaymentMethods}
                  value={names[method.id] ?? method.name}
                  onChange={(e) => {
                    if (!canManagePaymentMethods) return;
                    setNames((old) => ({ ...old, [method.id]: e.target.value }));
                  }}
                  className="flex-1 px-3 py-2 text-sm border rounded-lg disabled:bg-muted disabled:cursor-not-allowed"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canManagePaymentMethods || names[method.id] === method.name}
                  onClick={() => update(method, { name: names[method.id] })}
                >
                  <Save size={14} />
                </Button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    disabled={!canManagePaymentMethods}
                    checked={method.is_active}
                    onChange={(e) => update(method, { is_active: e.target.checked })}
                  />{' '}
                  {t('active')}
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canManagePaymentMethods || Boolean(method.usage_count)}
                  onClick={() => remove(method)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              {promptPaySaved[method.id] && (
                <div className="space-y-1" data-testid={`promptpay-account-form-${method.id}`}>
                  <label className="block text-xs font-medium text-foreground">
                    {t('qrAccountLabel')}
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      disabled={!canManagePaymentMethods}
                      inputMode="tel"
                      value={promptPayDrafts[method.id]?.account ?? ''}
                      onChange={(e) => setPromptPayDraft(method.id, { account: e.target.value })}
                      placeholder={t('qrAccountPlaceholder')}
                      aria-label={t('qrAccountLabel')}
                      className="flex-1 px-3 py-2 text-sm border rounded-lg"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('qrAccountLabel')}
                      disabled={
                        !canManagePaymentMethods ||
                        promptPayDrafts[method.id]?.account === promptPaySaved[method.id].account
                      }
                      onClick={() => savePromptPay(method.id, 'account')}
                    >
                      <Save size={14} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('qrAccountHint')}</p>
                  <label className="block pt-2 text-xs font-medium text-foreground">
                    {t('qrAccountNameLabel')}
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      disabled={!canManagePaymentMethods}
                      maxLength={60}
                      value={promptPayDrafts[method.id]?.name ?? ''}
                      onChange={(e) => setPromptPayDraft(method.id, { name: e.target.value })}
                      placeholder={t('qrAccountNamePlaceholder')}
                      aria-label={t('qrAccountNameLabel')}
                      className="flex-1 px-3 py-2 text-sm border rounded-lg"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('qrAccountNameLabel')}
                      disabled={
                        !canManagePaymentMethods ||
                        promptPayDrafts[method.id]?.name === promptPaySaved[method.id].name
                      }
                      onClick={() => savePromptPay(method.id, 'name')}
                    >
                      <Save size={14} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('qrAccountNameHint')}</p>
                  {promptPayMethodIds.length > 1 && (
                    <label className="flex items-center gap-1.5 pt-2 text-xs text-foreground">
                      <input
                        type="radio"
                        name="bill-qr-method"
                        disabled={!canManagePaymentMethods}
                        checked={effectiveBillQrMethodId === method.id}
                        onChange={() => saveBillQrMethod(method.id)}
                      />
                      {t('billQrMethodLabel')}
                    </label>
                  )}
                </div>
              )}
              {isBankAccountMethod(method.name) && (
                <div className="space-y-1" data-testid="bank-qr-account-form">
                  <label className="block text-xs font-medium text-foreground">
                    {t('bankQrAccountLabel')}
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      disabled={!canManagePaymentMethods}
                      inputMode="numeric"
                      value={bankAccount}
                      onChange={(e) => setBankAccount(e.target.value)}
                      placeholder={t('bankQrAccountNumberPlaceholder')}
                      aria-label={t('bankQrAccountNumberPlaceholder')}
                      className="flex-1 px-3 py-2 text-sm border rounded-lg"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('bankQrAccountLabel')}
                      disabled={!canManagePaymentMethods || bankAccount === bankAccountSaved}
                      onClick={saveBankAccount}
                    >
                      <Save size={14} />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('bankQrAccountHint')}</p>
                </div>
              )}
              {Boolean(method.usage_count) && canManagePaymentMethods && (
                <div className="flex gap-2 items-center">
                  <select
                    value={mergeTargets[method.id] || ''}
                    onChange={(e) =>
                      setMergeTargets((old) => ({ ...old, [method.id]: e.target.value }))
                    }
                    className="flex-1 px-2 py-1.5 text-xs border rounded-md bg-card"
                  >
                    <option value="">{t('mergeInto')}…</option>
                    <option value="card">{tPos('methodCard')}</option>
                    {methods
                      .filter((target) => target.id !== method.id)
                      .map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!mergeTargets[method.id]}
                    onClick={() => merge(method)}
                  >
                    <Merge size={14} className="me-1" />
                    {t('merge')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {canManagePaymentMethods && (
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add();
                }}
                placeholder={t('paymentMethodName')}
                className="flex-1 px-3 py-2 text-sm border rounded-lg"
              />
              <Button onClick={add} disabled={!newName.trim()}>
                <Plus size={14} className="me-1" />
                {tCommon('add')}
              </Button>
            </div>
          )}
          {canManagePaymentMethods && (
            <p className="text-xs text-muted-foreground">{t('promptPayMethodNameHint')}</p>
          )}
        </div>
      </div>

      <div
        data-setting-section="split-checks"
        className="bg-card rounded-xl border border-border p-6 flex items-center justify-between gap-4"
      >
        <div>
          <h2 className="font-semibold text-foreground">{t('splitChecks')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('splitChecksHint')}</p>
        </div>
        <input
          type="checkbox"
          className="size-5 disabled:cursor-not-allowed"
          disabled={!isAdmin}
          checked={splitChecksEnabled}
          onChange={async (e) => {
            if (!isAdmin) return;
            const value = e.target.checked;
            setSplitChecksEnabled(value);
            try {
              await api.put('/settings/split_checks_enabled', { value: String(value) });
            } catch {
              setSplitChecksEnabled(!value);
              toast.error(t('saveFailed'));
            }
          }}
        />
      </div>

      <div
        data-setting-section="card-transaction-id"
        className="bg-card rounded-xl border border-border p-6 flex items-center justify-between gap-4"
      >
        <div>
          <h2 id="card-transaction-id-required-label" className="font-semibold text-foreground">
            {t('cardTransactionIdRequired')}
          </h2>
          <p id="card-transaction-id-required-hint" className="text-sm text-muted-foreground mt-1">
            {t('cardTransactionIdRequiredHint')}
          </p>
        </div>
        {cardTransactionSettingState === 'error' ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-destructive">{t('loadFailed')}</span>
            <Button variant="outline" size="sm" onClick={() => void loadCardTransactionSetting()}>
              {t('retry')}
            </Button>
          </div>
        ) : (
          <input
            id="card-transaction-id-required"
            type="checkbox"
            aria-labelledby="card-transaction-id-required-label"
            aria-describedby="card-transaction-id-required-hint"
            className="size-5 shrink-0 disabled:cursor-not-allowed"
            disabled={
              !isAdmin ||
              cardTransactionSettingState !== 'ready' ||
              isSavingCardTransactionIdRequired
            }
            checked={cardTransactionIdRequired}
            onChange={async (e) => {
              if (
                !isAdmin ||
                isSavingCardTransactionIdRequired ||
                cardTransactionSaveInFlightRef.current
              )
                return;
              const previousValue = cardTransactionIdRequired;
              const value = e.target.checked;
              cardTransactionSaveEpochRef.current += 1;
              cardTransactionSaveInFlightRef.current = true;
              setCardTransactionIdRequired(value);
              setIsSavingCardTransactionIdRequired(true);
              try {
                await api.put('/settings/card_transaction_id_required', { value: String(value) });
                setCardTransactionIdRequired(value);
                setCardTransactionSettingState('ready');
              } catch {
                setCardTransactionIdRequired(previousValue);
                toast.error(t('saveFailed'));
              } finally {
                cardTransactionSaveInFlightRef.current = false;
                setIsSavingCardTransactionIdRequired(false);
              }
            }}
          />
        )}
      </div>

      <div
        data-setting-section="require-open-shift"
        className="bg-card rounded-xl border border-border p-6 flex items-center justify-between gap-4"
      >
        <div>
          <h2 id="require-open-shift-label" className="font-semibold text-foreground">
            {t('requireOpenShift')}
          </h2>
          <p id="require-open-shift-hint" className="text-sm text-muted-foreground mt-1">
            {t('requireOpenShiftHint')}
          </p>
        </div>
        <input
          id="require-open-shift"
          type="checkbox"
          aria-labelledby="require-open-shift-label"
          aria-describedby="require-open-shift-hint"
          className="size-5 shrink-0 disabled:cursor-not-allowed"
          disabled={!isAdmin}
          checked={requireOpenShift}
          onChange={async (e) => {
            if (!isAdmin) return;
            const value = e.target.checked;
            setRequireOpenShift(value);
            try {
              await api.put('/settings/require_open_shift', { value: String(value) });
            } catch {
              setRequireOpenShift(!value);
              toast.error(t('saveFailed'));
            }
          }}
        />
      </div>

      <div
        data-setting-section="one-shift-per-staff"
        className="bg-card rounded-xl border border-border p-6 flex items-center justify-between gap-4"
      >
        <div>
          <h2 id="one-shift-per-staff-label" className="font-semibold text-foreground">
            {t('oneShiftPerStaff')}
          </h2>
          <p id="one-shift-per-staff-hint" className="text-sm text-muted-foreground mt-1">
            {t('oneShiftPerStaffHint')}
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
            {t('oneShiftPerStaffSharedDrawerWarning')}
          </p>
        </div>
        <input
          id="one-shift-per-staff"
          type="checkbox"
          aria-labelledby="one-shift-per-staff-label"
          aria-describedby="one-shift-per-staff-hint"
          className="size-5 shrink-0 disabled:cursor-not-allowed"
          disabled={!isAdmin}
          checked={oneShiftPerStaff}
          onChange={async (e) => {
            if (!isAdmin) return;
            const value = e.target.checked;
            setOneShiftPerStaff(value);
            try {
              await api.put('/settings/one_shift_per_staff', { value: String(value) });
            } catch (err: unknown) {
              setOneShiftPerStaff(!value);
              const status = (err as { response?: { status?: number } })?.response?.status;
              if (status === 409) {
                toast.error(t('oneShiftPerStaffDisableBlocked'));
              } else {
                toast.error(t('saveFailed'));
              }
            }
          }}
        />
      </div>

      {merges.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-6">
          <h2 className="font-semibold text-foreground mb-3">{t('mergeHistory')}</h2>
          <div className="space-y-2 text-sm text-muted-foreground">
            {merges.map((entry) => (
              <p key={entry.id}>
                {entry.source_name} → {entry.target_name} · {entry.affected_payments} ·{' '}
                {formatDate(entry.merged_at)}
              </p>
            ))}
          </div>
        </div>
      )}
    </SettingsTabShell>
  );
}
