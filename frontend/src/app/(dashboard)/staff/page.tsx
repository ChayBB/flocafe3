'use client';

import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, X, Edit, RotateCcw, Eye, EyeOff, UserRound } from 'lucide-react';
import type { Staff } from '@/lib/types';
import { useTranslations, type AppConfig } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { PermissionMatrix } from '@/components/settings/PermissionMatrix';
import { PermissionAuditLog } from '@/components/settings/PermissionAuditLog';
import { validatePassword } from '@shared/password-policy';
import { AttendancePanel } from '@/components/staff/AttendancePanel';
import { ZoneResponsibilityPanel } from '@/components/staff/ZoneResponsibilityPanel';
import { StaffProfileDialog } from '@/components/staff/StaffProfileDialog';
import { OPERATIONAL_ROLES, ROLE_ACCESS, ROLE_KEYS, hasRole } from '@shared/role-permissions';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';
import { tenantCan } from '@/lib/permissions';

const VALID_ROLES = ROLE_KEYS;

type StaffKey = keyof AppConfig['Messages']['staff'];

const roleColors: Record<string, string> = {
  owner: 'bg-red-100 text-red-800',
  manager: 'bg-purple-100 text-purple-800',
  cashier: 'bg-orange-100 text-orange-800',
  server: 'bg-green-100 text-green-800',
  chef: 'bg-orange-100 text-orange-800',
};

function roleLabel(role: string, t: (key: StaffKey) => string): string {
  const key = ROLE_LABEL_KEYS[role];
  return key ? t(key) : role;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const apiError = error.response?.data?.error;
    if (typeof apiError === 'string' && apiError.trim()) return apiError;
  }
  return fallback;
}

const isOperationalRole = (role: string) => hasRole(role, OPERATIONAL_ROLES);

function validateStaffPassword(role: string, password: string): boolean {
  return isOperationalRole(role) ? /^\d{4}$/.test(password) : validatePassword(password);
}

type StaffTab = 'staff' | 'attendance' | 'zones' | 'permissions';
const STAFF_TABS = [
  { tab: 'staff', labelKey: 'tabStaff' },
  { tab: 'attendance', labelKey: 'tabAttendance' },
  { tab: 'zones', labelKey: 'tabZones' },
  { tab: 'permissions', labelKey: 'tabPermissions' },
] as const satisfies readonly { tab: StaffTab; labelKey: StaffKey }[];
const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, 4);

export default function StaffPage() {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const tAuth = useTranslations('auth');
  const tSetup = useTranslations('setup');
  const { currentTenant } = useAuthStore();
  const canManagePermissions = tenantCan(currentTenant, 'authorization.manage');
  const canManageStaff = tenantCan(currentTenant, 'staff.operational.manage');
  const canViewStaff = tenantCan(currentTenant, 'staff.view');
  const canManagePrivilegedStaff = tenantCan(currentTenant, 'staff.privileged.manage');
  const canViewTables = tenantCan(currentTenant, 'tables.view');
  const canManageTables = tenantCan(currentTenant, 'tables.manage');
  const [tab, setTab] = useState<StaffTab>('staff');
  const [profileStaff, setProfileStaff] = useState<Staff | null>(null);
  const tabAllowed: Record<StaffTab, boolean> = {
    staff: true,
    attendance: canViewStaff,
    zones: canViewTables,
    permissions: canManagePermissions,
  };
  const tabs = STAFF_TABS.filter(({ tab: entry }) => tabAllowed[entry]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [kitchenStations, setKitchenStations] = useState<{ id: string; name: string }[]>([]);
  const [kdsEnabled, setKdsEnabled] = useState(true);
  const [, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null);
  const [showResetPw, setShowResetPw] = useState(false);
  const [resetPwStaff, setResetPwStaff] = useState<Staff | null>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    role: 'server',
    pin: '',
    staff_code: '',
    station_ids: [] as string[],
  });
  const requiresPassword =
    !editingStaff || (isOperationalRole(editingStaff.role) && !isOperationalRole(form.role));
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const resetPwTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const formTriggerRef = useRef<HTMLElement | null>(null);
  const resetPwTriggerRef = useRef<HTMLElement | null>(null);

  const fetchStaff = async () => {
    try {
      const { data } = await api.get(canManagePermissions ? '/authorization/users' : '/staff');
      setStaff(data.staff || data.users || []);
    } catch {
      toast.error(t('failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api
      .get(canManagePermissions ? '/authorization/users' : '/staff')
      .then(({ data }) => setStaff(data.staff || data.users || []))
      .catch(() => toast.error(t('failedToLoad')))
      .finally(() => setLoading(false));
    api
      .get('/kitchen-stations')
      .then(({ data }) => setKitchenStations(data.kitchenStations || []))
      .catch(() => setKitchenStations([]));
    api
      .get('/settings/kds_enabled')
      .then(({ data }) => setKdsEnabled(data.setting?.value !== 'false'))
      .catch(() => setKdsEnabled(true));
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [canManagePermissions]);

  const openAdd = (e?: React.MouseEvent<HTMLButtonElement>) => {
    formTriggerRef.current = e?.currentTarget ?? addTriggerRef.current;
    setEditingStaff(null);
    setForm({
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      role: 'server',
      pin: '',
      staff_code: '',
      station_ids: [],
    });
    setShowPassword(false);
    setShowPin(false);
    setShowForm(true);
  };

  const openEdit = (s: Staff, e?: React.MouseEvent<HTMLButtonElement>) => {
    formTriggerRef.current = e?.currentTarget ?? editTriggerRefs.current[s.id] ?? null;
    setEditingStaff(s);
    setForm({
      name: s.name,
      email: s.email || '',
      password: '',
      confirmPassword: '',
      role: s.role,
      pin: '',
      staff_code: '',
      station_ids: [],
    });
    setShowPassword(false);
    setShowPin(false);
    setShowForm(true);
  };

  const openResetPw = (s: Staff, e?: React.MouseEvent<HTMLButtonElement>) => {
    resetPwTriggerRef.current = e?.currentTarget ?? resetPwTriggerRefs.current[s.id] ?? null;
    setResetPwStaff(s);
    setNewPassword('');
    setConfirmNewPassword('');
    setShowResetPassword(false);
    setShowResetPw(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password && form.password !== form.confirmPassword) {
      toast.error(tSetup('passwordsMismatch'));
      return;
    }
    if ((requiresPassword || form.password) && !validateStaffPassword(form.role, form.password)) {
      toast.error(
        isOperationalRole(form.role)
          ? t('operationalPasswordHint')
          : tSetup('errorPasswordRequirementsNotMet'),
      );
      return;
    }
    try {
      if (editingStaff) {
        await api.put(`/staff/${editingStaff.id}`, {
          name: form.name,
          email: form.email,
          role: form.role,
          ...(form.password ? { password: form.password } : {}),
          ...(form.pin ? { pin: form.pin } : {}),
          ...(form.staff_code ? { staff_code: form.staff_code } : {}),
        });
        toast.success(t('updatedToast'));
      } else {
        await api.post('/staff', {
          name: form.name,
          email: form.email,
          password: form.password,
          role: form.role,
          ...(form.pin ? { pin: form.pin } : {}),
          ...(form.staff_code ? { staff_code: form.staff_code } : {}),
          ...(form.role === 'chef' ? { station_ids: form.station_ids } : {}),
        });
        toast.success(t('addedToast'));
      }
      closeForm();
      fetchStaff();
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('failedToSave')));
    }
  };

  const handleResetPassword = async () => {
    if (!resetPwStaff || !newPassword) return;
    if (newPassword !== confirmNewPassword) {
      toast.error(tSetup('passwordsMismatch'));
      return;
    }
    if (!validateStaffPassword(resetPwStaff.role, newPassword)) {
      toast.error(
        isOperationalRole(resetPwStaff.role)
          ? t('operationalPasswordHint')
          : tSetup('errorPasswordRequirementsNotMet'),
      );
      return;
    }
    try {
      await api.put(`/staff/${resetPwStaff.id}`, { password: newPassword });
      toast.success(t('resetPasswordToast'));
      closeResetPassword();
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('failedToReset')));
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setShowPassword(false);
    setShowPin(false);
    formTriggerRef.current?.focus();
  };

  const closeResetPassword = () => {
    setShowResetPw(false);
    setShowResetPassword(false);
    resetPwTriggerRef.current?.focus();
  };

  useEffect(() => {
    if (!showForm && !showResetPw) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showForm) closeForm();
      if (showResetPw) closeResetPassword();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showForm, showResetPw]);

  const toggleActive = async (s: Staff) => {
    try {
      await api.post(`/staff/${s.id}/${s.is_active ? 'deactivate' : 'reactivate'}`);
      fetchStaff();
    } catch {
      toast.error(t('failedToUpdate'));
    }
  };

  const editingLastActiveOwner =
    Boolean(editingStaff?.is_active) &&
    editingStaff?.role === 'owner' &&
    staff.filter((s) => s.role === 'owner' && Boolean(s.is_active)).length === 1;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        {canManageStaff && tab === 'staff' && (
          <Button ref={addTriggerRef} onClick={openAdd}>
            <Plus size={16} className="me-1" /> {t('addButton')}
          </Button>
        )}
      </div>

      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label={t('title')}
          className="mb-6 inline-flex rounded-lg border border-border p-1"
        >
          {tabs.map(({ tab: entry, labelKey }) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              data-testid={`staff-tab-${entry}`}
              onClick={() => setTab(entry)}
              className={`rounded px-3 py-1.5 text-sm ${tab === entry ? 'bg-brand text-white' : 'text-muted-foreground'}`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      )}

      {tab === 'staff' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {staff.map((s) => (
              <div
                key={s.id}
                className={`bg-card rounded-xl p-5 border ${s.is_active ? 'border-border' : 'border-border opacity-60'}`}
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <p className="font-bold text-foreground">{s.name}</p>
                    <p className="text-xs text-muted-foreground">{s.email || '—'}</p>
                    {Boolean(s.has_pin) && (
                      <p className="text-xs text-green-600 mt-1">{t('pinSet')}</p>
                    )}
                    {Boolean(s.has_staff_code) && (
                      <p className="text-xs text-green-600 mt-1">{t('staffCodeSet')}</p>
                    )}
                  </div>
                  <span
                    className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${roleColors[s.role] || 'bg-muted text-foreground'}`}
                  >
                    {roleLabel(s.role, t)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="staff-profile-button"
                    onClick={() => setProfileStaff(s)}
                  >
                    <UserRound size={14} className="me-1" /> {t('profileButton')}
                  </Button>
                  {canManageStaff &&
                    (canManagePrivilegedStaff || !hasRole(s.role, ROLE_ACCESS.ownerManager)) && (
                      <>
                        <Button
                          ref={(el) => {
                            editTriggerRefs.current[s.id] = el;
                          }}
                          variant="outline"
                          size="sm"
                          onClick={(e) => openEdit(s, e)}
                        >
                          <Edit size={14} className="me-1" /> {tCommon('edit')}
                        </Button>
                        <Button
                          ref={(el) => {
                            resetPwTriggerRefs.current[s.id] = el;
                          }}
                          variant="outline"
                          size="sm"
                          onClick={(e) => openResetPw(s, e)}
                        >
                          <RotateCcw size={14} className="me-1" /> {t('resetPwButton')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleActive(s)}
                          className={
                            s.is_active
                              ? 'text-red-500 hover:text-red-700 hover:bg-red-50'
                              : 'text-green-500 hover:text-green-700 hover:bg-green-50'
                          }
                        >
                          {s.is_active ? t('deactivate') : t('reactivate')}
                        </Button>
                      </>
                    )}
                </div>
              </div>
            ))}
          </div>

          {staff.length === 0 && (
            <p className="text-center text-muted-foreground py-12">{t('empty')}</p>
          )}
        </>
      )}
      {tab === 'attendance' && canViewStaff && <AttendancePanel canManage={canManageStaff} />}
      {tab === 'zones' && canViewTables && (
        <ZoneResponsibilityPanel staff={staff} canManageTables={canManageTables} />
      )}
      {tab === 'permissions' && canManagePermissions && (
        <div className="[&>section:first-child]:mt-0">
          <PermissionMatrix staff={staff} />
          <PermissionAuditLog staff={staff} />
        </div>
      )}
      {profileStaff && (
        <StaffProfileDialog
          member={profileStaff}
          roleLabel={roleLabel(profileStaff.role, t)}
          canViewTables={canViewTables}
          onClose={() => setProfileStaff(null)}
        />
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-modal-title"
            className="bg-card rounded-2xl p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-4">
              <h2 id="staff-modal-title" className="text-lg font-bold">
                {editingStaff ? t('modalTitleEdit') : t('modalTitleAdd')}
              </h2>
              <button type="button" onClick={closeForm} aria-label={tCommon('close')}>
                <X size={20} className="text-gray-400" />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <input
                type="text"
                placeholder={t('namePlaceholder')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                required
              />
              <div>
                <input
                  type="email"
                  placeholder={t('emailOptional')}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  autoComplete="email"
                  dir="ltr"
                />
                {!form.email.trim() && (
                  <p className="mt-1 text-xs text-muted-foreground">{t('emailOptionalHint')}</p>
                )}
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder={
                    isOperationalRole(form.role)
                      ? t('operationalPasswordPlaceholder')
                      : editingStaff
                        ? t('newPasswordPlaceholder')
                        : t('passwordPlaceholder')
                  }
                  value={form.password}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      password: isOperationalRole(form.role)
                        ? digitsOnly(e.target.value)
                        : e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 pe-10 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  required={requiresPassword}
                  {...(isOperationalRole(form.role)
                    ? { inputMode: 'numeric' as const, maxLength: 4, pattern: '[0-9]{4}' }
                    : {})}
                />
                <button
                  type="button"
                  aria-label="Toggle password visibility"
                  title="Toggle password visibility"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder={tAuth('confirmPassword')}
                value={form.confirmPassword}
                onChange={(e) =>
                  setForm({
                    ...form,
                    confirmPassword: isOperationalRole(form.role)
                      ? digitsOnly(e.target.value)
                      : e.target.value,
                  })
                }
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                required={requiresPassword || Boolean(form.password)}
                {...(isOperationalRole(form.role)
                  ? { inputMode: 'numeric' as const, maxLength: 4, pattern: '[0-9]{4}' }
                  : {})}
              />
              {isOperationalRole(form.role) && (
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('operationalPasswordHint')}
                </p>
              )}
              <select
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value;
                  const passwordKindChanged =
                    isOperationalRole(role) !== isOperationalRole(form.role);
                  setForm({
                    ...form,
                    role,
                    ...(passwordKindChanged ? { password: '', confirmPassword: '' } : {}),
                    station_ids: role === 'chef' ? form.station_ids : [],
                  });
                }}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              >
                {VALID_ROLES.filter(
                  (role) => canManagePrivilegedStaff || !hasRole(role, ROLE_ACCESS.ownerManager),
                ).map((r) => (
                  <option key={r} value={r} disabled={editingLastActiveOwner && r !== 'owner'}>
                    {roleLabel(r, t)}
                  </option>
                ))}
              </select>
              {!editingStaff && form.role === 'chef' && (
                <div>
                  <p className="text-sm font-medium text-foreground mb-1">
                    {t('kitchenStationsOptional')}
                  </p>
                  <div
                    className={`space-y-1 rounded-lg border border-border p-2 ${!kdsEnabled ? 'opacity-60' : ''}`}
                  >
                    {kitchenStations.map((station) => (
                      <label
                        key={station.id}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={form.station_ids.includes(station.id)}
                          onChange={() =>
                            setForm((current) => ({
                              ...current,
                              station_ids: current.station_ids.includes(station.id)
                                ? current.station_ids.filter((id) => id !== station.id)
                                : [...current.station_ids, station.id],
                            }))
                          }
                          disabled={!kdsEnabled}
                          className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                        />
                        {station.name}
                      </label>
                    ))}
                    {kitchenStations.length === 0 && (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        {t('noKitchenStations')}
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {kdsEnabled ? t('kitchenStationsOptionalHint') : t('kitchenStationsRequireKds')}
                  </p>
                </div>
              )}
              <div>
                <input
                  type="text"
                  placeholder={
                    editingStaff ? t('staffCodePlaceholderEdit') : t('staffCodePlaceholderAdd')
                  }
                  value={form.staff_code}
                  onChange={(e) =>
                    setForm({ ...form, staff_code: e.target.value.replace(/\D/g, '').slice(0, 4) })
                  }
                  className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  maxLength={4}
                  pattern="[0-9]{4}"
                  inputMode="numeric"
                  autoComplete="off"
                  data-testid="staff-code-input"
                />
                <p className="text-xs text-muted-foreground mt-1">{t('staffCodeHint')}</p>
              </div>
              <div>
                <div className="relative">
                  <input
                    type={showPin ? 'text' : 'password'}
                    placeholder={editingStaff ? t('pinPlaceholderEdit') : t('pinPlaceholderAdd')}
                    value={form.pin}
                    onChange={(e) =>
                      setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })
                    }
                    className="w-full px-3 py-2 pe-10 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    maxLength={6}
                    pattern="[0-9]*"
                    inputMode="numeric"
                  />
                  <button
                    type="button"
                    aria-label="Toggle PIN visibility"
                    title="Toggle PIN visibility"
                    onClick={() => setShowPin(!showPin)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{t('pinHint')}</p>
              </div>
              <Button type="submit" className="w-full">
                {editingStaff ? t('updateButton') : t('addButton')}
              </Button>
            </form>
          </div>
        </div>
      )}

      {showResetPw && resetPwStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-password-modal-title"
            className="bg-card rounded-2xl p-6 w-full max-w-sm"
          >
            <div className="flex justify-between items-center mb-4">
              <h2 id="reset-password-modal-title" className="text-lg font-bold">
                {t('resetPasswordTitle')}
              </h2>
              <button type="button" onClick={closeResetPassword} aria-label={tCommon('close')}>
                <X size={20} className="text-gray-400" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {t('resetPasswordBody', { name: resetPwStaff.name })}
            </p>
            <div className="space-y-4">
              <div className="relative">
                <input
                  type={showResetPassword ? 'text' : 'password'}
                  placeholder={
                    isOperationalRole(resetPwStaff.role)
                      ? t('operationalPasswordPlaceholder')
                      : t('newPasswordPlaceholder')
                  }
                  value={newPassword}
                  onChange={(e) =>
                    setNewPassword(
                      isOperationalRole(resetPwStaff.role)
                        ? digitsOnly(e.target.value)
                        : e.target.value,
                    )
                  }
                  className="w-full px-3 py-2 pe-10 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  {...(isOperationalRole(resetPwStaff.role)
                    ? { inputMode: 'numeric' as const, maxLength: 4 }
                    : {})}
                />
                <button
                  type="button"
                  aria-label="Toggle password visibility"
                  title="Toggle password visibility"
                  onClick={() => setShowResetPassword(!showResetPassword)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showResetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <input
                type={showResetPassword ? 'text' : 'password'}
                placeholder={tAuth('confirmPassword')}
                value={confirmNewPassword}
                onChange={(e) =>
                  setConfirmNewPassword(
                    isOperationalRole(resetPwStaff.role)
                      ? digitsOnly(e.target.value)
                      : e.target.value,
                  )
                }
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                {...(isOperationalRole(resetPwStaff.role)
                  ? { inputMode: 'numeric' as const, maxLength: 4 }
                  : {})}
              />
              {isOperationalRole(resetPwStaff.role) && (
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('operationalPasswordHint')}
                </p>
              )}
              <Button onClick={handleResetPassword} className="w-full">
                {t('resetPasswordTitle')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
