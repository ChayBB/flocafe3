'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  BarChart3,
  ChevronRight,
  Clock,
  Home,
  LayoutGrid,
  LogOut,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Utensils,
  UserRound,
  Users,
} from 'lucide-react';
import { useLocale, useTranslations } from 'use-intl';
import { FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP } from '@/lib/font-scale';
import type { Language } from '@/lib/i18n/languages';
import { parseDbTimestamp } from '@/lib/utils';
import { StaffTableRangeForm } from './StaffTableRangeForm';

type ProfileData = {
  business_date: string;
  timezone: string;
  attendance: {
    business_date: string;
    clock_in_at: string;
    clock_out_at: string | null;
  }[];
  summary: { sales: number; bills: number; guests: number };
  assignment_mode?: string;
  backup_enabled?: boolean;
};

type ProfileTable = {
  id: string;
  name?: string;
  number?: string;
  status?: string;
  floor?: string | null;
  owner_user_id?: string | null;
  backup_user_id?: string | null;
};

const tableLabel = (table: ProfileTable) => String(table.name ?? table.number ?? '');
const byTableName = (a: ProfileTable, b: ProfileTable) =>
  tableLabel(a).localeCompare(tableLabel(b), undefined, { numeric: true });

type Panel = 'profile' | 'personal' | 'tables' | 'sales' | 'preferences' | 'history';

const card = 'rounded-2xl border border-border bg-card p-4';
const action =
  'flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-xl px-3 text-base font-semibold';
const accentText = 'text-orange-600 dark:text-orange-400';
const accentSoft = 'bg-orange-50 dark:bg-orange-950/40';
const accentBorder = 'border-orange-600 dark:border-orange-400';
const choice = (selected: boolean) =>
  `${action} border-2 text-lg ${selected ? `${accentBorder} ${accentSoft} ${accentText}` : 'border-border bg-background'}`;
const tableTone = {
  primary: {
    card: 'border-green-600 bg-[#EEF8F1] dark:border-green-500 dark:bg-green-950/40',
    icon: 'text-green-700 dark:text-green-400',
  },
  backup: {
    card: 'border-amber-500 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/40',
    icon: 'text-amber-600 dark:text-amber-400',
  },
} as const;
const stepButton = `${action} size-14 rounded-full border-2 border-border bg-background disabled:opacity-40`;

export function StaffProfile({
  api,
  user,
  tables,
  allTables,
  onTablesChanged,
  language,
  onLanguage,
  dark,
  onDark,
  fontScale,
  onFontScale,
  formatMoney,
  onClose,
  onOrders,
  onTable,
  onLogout,
}: {
  api: AxiosInstance | null;
  user: { id: string; name: string; role: string; email: string };
  tables: ProfileTable[];
  allTables: ProfileTable[];
  onTablesChanged: () => void;
  language: Language;
  onLanguage: (language: Language) => void;
  dark: boolean;
  onDark: () => void;
  fontScale: number;
  onFontScale: (scale: number) => void;
  formatMoney: (amount: number) => string;
  onClose: () => void;
  onOrders: () => void;
  onTable: (id?: string) => void;
  onLogout: () => void;
}) {
  const t = useTranslations('staffProfile');
  const staff = useTranslations('staff');
  const kds = useTranslations('kds');
  const locale = useLocale();
  const [panel, setPanel] = useState<Panel>('profile');
  const [snapshot, setSnapshot] = useState<ProfileData | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [picking, setPicking] = useState(false);
  const [savingTables, setSavingTables] = useState(false);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.get<ProfileData>('/api/staff-profile').then(
      ({ data }) => {
        if (cancelled) return;
        setSnapshot(data);
        setLoadedAt(new Date());
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, user.id, refresh]);

  const today = snapshot?.attendance.find(
    (entry) => entry.business_date === snapshot.business_date,
  );
  const active = Boolean(today && !today.clock_out_at);
  const formatTime = (value: string | Date | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: snapshot?.timezone,
        }).format(typeof value === 'string' ? parseDbTimestamp(value) : value)
      : '—';
  const roles: Record<
    string,
    'roleServer' | 'roleOwner' | 'roleManager' | 'roleCashier' | 'roleChef'
  > = {
    server: 'roleServer',
    owner: 'roleOwner',
    manager: 'roleManager',
    cashier: 'roleCashier',
    chef: 'roleChef',
  };
  const role = roles[user.role] ? staff(roles[user.role]) : user.role;
  const primaryTables = tables.filter((table) => table.owner_user_id === user.id).sort(byTableName);
  const backupTables = tables
    .filter((table) => table.owner_user_id !== user.id && table.backup_user_id === user.id)
    .sort(byTableName);
  const zones = [
    ...new Set(primaryTables.map((table) => table.floor?.trim()).filter(Boolean)),
  ].join(', ');
  const roleLine = zones ? `${role} · ${t('zone', { zone: zones })}` : role;
  const tiles = [
    {
      id: 'sales',
      icon: BarChart3,
      detail: snapshot ? formatMoney(snapshot.summary.sales) : '—',
    },
    { id: 'history', icon: Clock, detail: t('historyHint') },
    { id: 'preferences', icon: Settings, detail: t('preferencesHint') },
  ] as const;

  const sectionHeader = (title: string, extra?: ReactNode) => (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-xl font-bold">{title}</h2>
      {extra}
    </div>
  );
  const viewAll = (target: Panel) =>
    panel === 'profile' && (
      <button type="button" onClick={() => setPanel(target)} className={`${action} ${accentText}`}>
        {t('viewAll')}
        <ChevronRight size={20} aria-hidden="true" />
      </button>
    );

  const summary = (
    <section className={card}>
      {sectionHeader(
        t('todaySummary'),
        <button
          type="button"
          className={`${action} border-2 border-border`}
          aria-label={t('refresh')}
          onClick={() => {
            setFailed(false);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={22} className={accentText} aria-hidden="true" />
        </button>,
      )}
      {loadedAt && (
        <p className="mb-3 text-base text-muted-foreground">
          {t('lastUpdated', { time: formatTime(loadedAt) })}
        </p>
      )}
      {failed && (
        <p role="status" className="mb-3 text-base font-semibold text-red-700 dark:text-red-300">
          {t('summaryUnavailable')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
        {(
          [
            [ShoppingBag, 'sales', snapshot && formatMoney(snapshot.summary.sales)],
            [ReceiptText, 'bills', snapshot?.summary.bills],
            [Users, 'guests', snapshot?.summary.guests],
          ] as const
        ).map(([Metric, label, value]) => (
          <div
            key={label}
            className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/60 p-3 min-[400px]:flex-col min-[400px]:text-center"
          >
            <Metric size={26} className={`shrink-0 ${accentText}`} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-base">{t(label)}</p>
              <p className="break-words text-2xl font-bold tabular-nums" dir="auto">
                {value ?? '—'}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
  const staffManaged = snapshot?.assignment_mode === 'staff_managed';
  const startPicking = () => setPicking(true);
  const saveTables = async (tableIds: string[], backupTableIds: string[] | undefined) => {
    if (!api || savingTables) return;
    setSavingTables(true);
    try {
      await api.put('/api/staff-profile/tables', {
        table_ids: tableIds,
        ...(backupTableIds ? { backup_table_ids: backupTableIds } : {}),
      });
      toast.success(t('tablesSaved'));
      setPicking(false);
      onTablesChanged();
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
      const taken = code === 'TABLE_OWNED_BY_OTHER' || code === 'TABLE_BACKUP_TAKEN';
      const stale = taken || code === 'STAFF_MANAGED_MODE_OFF' || code === 'TABLE_BACKUP_DISABLED';
      toast.error(
        taken
          ? t('tablesTaken')
          : code === 'STAFF_MANAGED_MODE_OFF'
            ? t('tablesModeOff')
            : t('tablesSaveFailed'),
      );
      if (stale) {
        setPicking(false);
        onTablesChanged();
        setRefresh((value) => value + 1);
      }
    } finally {
      setSavingTables(false);
    }
  };
  const tablePicker = picking && (
    <StaffTableRangeForm
      tables={allTables.map((table) => ({
        id: table.id,
        label: tableLabel(table),
        owner_user_id: table.owner_user_id,
        backup_user_id: table.backup_user_id,
      }))}
      userId={user.id}
      backupEnabled={Boolean(snapshot?.backup_enabled)}
      saving={savingTables}
      onSave={(tableIds, backupTableIds) => void saveTables(tableIds, backupTableIds)}
      onCancel={() => setPicking(false)}
    />
  );
  const openPicker = () => {
    setPanel('tables');
    startPicking();
  };
  const tableCard = (table: ProfileTable, tone: keyof typeof tableTone) => {
    const busy = Boolean(table.status && table.status !== 'available');
    return (
      <button
        key={table.id}
        type="button"
        onClick={() => onTable(table.id)}
        className={`flex min-h-20 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border-2 px-1 py-2 ${tableTone[tone].card}`}
      >
        <Utensils size={22} className={tableTone[tone].icon} aria-hidden="true" />
        <span className="max-w-full break-words text-center text-lg font-bold leading-tight">
          {t('tableName', { name: tableLabel(table) })}
        </span>
        {busy ? (
          <span className="text-sm text-muted-foreground">{t('tableBusy')}</span>
        ) : (
          <span className="sr-only">{t('tableAvailable')}</span>
        )}
      </button>
    );
  };
  const tableGroup = (caption: string, list: ProfileTable[], tone: keyof typeof tableTone) =>
    list.length > 0 && (
      <div>
        <p className="mb-2 text-base text-muted-foreground">{caption}</p>
        <div className="grid grid-cols-3 gap-2">{list.map((table) => tableCard(table, tone))}</div>
      </div>
    );
  const myTables = (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => (staffManaged ? openPicker() : setPanel('tables'))}
        disabled={panel === 'tables' && !staffManaged}
        data-testid="staff-profile-my-tables"
        className="flex min-h-12 w-full items-center gap-3 text-start disabled:cursor-default"
      >
        <LayoutGrid size={24} className={accentText} aria-hidden="true" />
        <span className="min-w-0 flex-1 text-xl font-bold">{t('myTables')}</span>
        {staffManaged ? (
          <span className={`text-base font-semibold ${accentText}`}>{t('manageTablesShort')}</span>
        ) : (
          <span className="text-base text-muted-foreground">
            {t('tableCount', { count: tables.length })}
          </span>
        )}
        {(panel !== 'tables' || staffManaged) && (
          <ChevronRight size={22} className="text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      {tables.length === 0 ? (
        <p className="text-lg text-muted-foreground">{t('noTables')}</p>
      ) : (
        <>
          {tableGroup(t('primaryTables'), primaryTables, 'primary')}
          {tableGroup(t('backupTables'), backupTables, 'backup')}
        </>
      )}
      {staffManaged && (
        <button
          type="button"
          onClick={openPicker}
          className={`${action} w-full border border-border bg-card text-lg`}
        >
          <SlidersHorizontal size={22} aria-hidden="true" />
          {t('manageTables')}
        </button>
      )}
    </div>
  );
  const history = (
    <section className={card}>
      {sectionHeader(panel === 'profile' ? t('todayWork') : t('history'), viewAll('history'))}
      {!(panel === 'profile' ? today : snapshot?.attendance.length) ? (
        <p className="text-lg text-muted-foreground">{t('noAttendance')}</p>
      ) : (
        (panel === 'profile' && today ? [today] : (snapshot?.attendance ?? [])).map((entry) => (
          <div
            key={entry.business_date}
            className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-border py-3 text-lg first-of-type:border-t-0"
          >
            <span className="flex items-center gap-2">
              <Clock size={22} className={accentText} aria-hidden="true" />
              {entry.business_date}
            </span>
            <span dir="ltr" className="font-semibold tabular-nums">
              {formatTime(entry.clock_in_at)} – {formatTime(entry.clock_out_at)}
            </span>
            {!entry.clock_out_at && (
              <span className="rounded-full border-2 border-green-700 px-3 py-1 text-base font-semibold text-green-800 dark:border-green-400 dark:text-green-300">
                {t('clockedIn')}
              </span>
            )}
          </div>
        ))
      )}
    </section>
  );

  return (
    <div data-testid="server-app-staff-profile" className="min-h-dvh bg-muted/40 text-foreground">
      <div className="mx-auto min-h-dvh max-w-lg bg-background">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b-2 border-border bg-card px-2 py-2">
          <button
            type="button"
            className={action}
            aria-label={t('back')}
            onClick={panel === 'profile' ? onClose : () => setPanel('profile')}
          >
            <ArrowLeft size={26} aria-hidden="true" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-2xl font-bold">{t(panel)}</h1>
          {panel === 'profile' && (
            <button type="button" className={`${action} border-2 border-border`} onClick={onLogout}>
              <LogOut size={22} aria-hidden="true" />
              <span className="hidden min-[400px]:inline">{t('logout')}</span>
              <span className="sr-only min-[400px]:hidden">{t('logout')}</span>
            </button>
          )}
        </header>
        <main className={`space-y-4 px-3 pt-4 ${panel === 'profile' ? 'pb-28' : 'pb-8'}`}>
          {panel === 'profile' && (
            <>
              <section className={card}>
                <button
                  type="button"
                  onClick={() => setPanel('personal')}
                  className="flex min-h-16 w-full items-center gap-4 text-start"
                >
                  <span
                    className="grid size-16 shrink-0 place-items-center rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <UserRound size={32} className="text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-2xl font-bold">{user.name}</span>
                    <span className="block text-lg text-muted-foreground" dir="auto">
                      {roleLine}
                    </span>
                    {active && (
                      <span className="mt-1 inline-flex items-center gap-2 rounded-full border-2 border-green-700 px-3 py-0.5 text-base font-semibold text-green-800 dark:border-green-400 dark:text-green-300">
                        <span className="size-3 rounded-full bg-green-700 dark:bg-green-400" />
                        {t('working')}
                      </span>
                    )}
                  </span>
                  <ChevronRight size={24} className="text-muted-foreground" aria-hidden="true" />
                </button>
                <div className="my-4 border-t border-border" />
                {myTables}
              </section>
              <div className="grid grid-cols-2 gap-3">
                {tiles.map(({ id, icon: Icon, detail }, index) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPanel(id)}
                    className={`flex min-w-0 gap-3 text-start active:bg-muted ${card} ${index === tiles.length - 1 && tiles.length % 2 ? 'col-span-2 items-center' : 'min-h-32 flex-col items-start justify-between'}`}
                  >
                    <span
                      className={`grid size-12 shrink-0 place-items-center rounded-xl ${accentSoft}`}
                      aria-hidden="true"
                    >
                      <Icon size={28} className={accentText} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-bold leading-snug">{t(id)}</span>
                      <span
                        className="block break-words text-base text-muted-foreground"
                        dir="auto"
                      >
                        {detail}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {summary}
              {history}
            </>
          )}
          {panel === 'personal' && (
            <section className={card}>
              <dl className="divide-y-2 divide-border text-lg">
                {(
                  [
                    ['name', user.name],
                    ['email', user.email || '—'],
                    ['role', role],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="py-3 first:pt-0 last:pb-0">
                    <dt className="text-base text-muted-foreground">{t(label)}</dt>
                    <dd className="break-all font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {panel === 'tables' && (tablePicker || <section className={card}>{myTables}</section>)}
          {panel === 'sales' && summary}
          {panel === 'history' && history}
          {panel === 'preferences' && (
            <section className={`space-y-6 ${card}`}>
              <div>
                <p className="mb-2 text-lg font-bold">{t('fontSize')}</p>
                <div
                  role="group"
                  aria-label={t('fontSize')}
                  className="flex items-center justify-between gap-3"
                >
                  <button
                    type="button"
                    data-testid="staff-font-smaller"
                    aria-label={kds('fontSizeSmaller')}
                    disabled={fontScale <= FONT_SCALE_MIN}
                    onClick={() => onFontScale(fontScale - FONT_SCALE_STEP)}
                    className={stepButton}
                  >
                    <Minus size={26} aria-hidden="true" />
                  </button>
                  <span
                    data-testid="staff-font-scale-value"
                    aria-live="polite"
                    className="flex-1 text-center text-2xl font-bold tabular-nums"
                  >
                    {fontScale}%
                  </span>
                  <button
                    type="button"
                    data-testid="staff-font-larger"
                    aria-label={kds('fontSizeLarger')}
                    disabled={fontScale >= FONT_SCALE_MAX}
                    onClick={() => onFontScale(fontScale + FONT_SCALE_STEP)}
                    className={stepButton}
                  >
                    <Plus size={26} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div>
                <p className="mb-2 text-lg font-bold">{t('theme')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {[false, true].map((value) => (
                    <button
                      type="button"
                      key={String(value)}
                      aria-pressed={dark === value}
                      onClick={() => {
                        if (dark !== value) onDark();
                      }}
                      className={choice(dark === value)}
                    >
                      {t(value ? 'dark' : 'light')}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-lg font-bold">{t('language')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['th', 'ไทย'],
                      ['en', 'English'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      lang={value}
                      aria-pressed={language === value}
                      onClick={() => onLanguage(value)}
                      className={choice(language === value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
        </main>
        {panel === 'profile' && (
          <nav className="fixed inset-x-0 bottom-0 z-10 mx-auto grid max-w-lg grid-cols-4 border-t-2 border-border bg-card pb-[env(safe-area-inset-bottom)]">
            {[
              { label: 'home', icon: Home, run: onClose },
              { label: 'orders', icon: ReceiptText, run: onOrders },
              { label: 'navTables', icon: Utensils, run: () => onTable() },
              {
                label: 'navProfile',
                icon: UserRound,
                run: () => setPanel('profile'),
              },
            ].map(({ label, icon: Icon, run }) => (
              <button
                key={label}
                type="button"
                onClick={run}
                aria-current={label === 'navProfile' ? 'page' : undefined}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-base leading-tight ${label === 'navProfile' ? `font-bold ${accentText}` : 'text-muted-foreground'}`}
              >
                <Icon size={26} aria-hidden="true" />
                <span className="max-w-full truncate">
                  {t(label as 'home' | 'orders' | 'navTables' | 'navProfile')}
                </span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
