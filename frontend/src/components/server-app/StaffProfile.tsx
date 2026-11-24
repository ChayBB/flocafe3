'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AxiosInstance } from 'axios';
import {
  ArrowLeft,
  BarChart3,
  ChevronRight,
  Clock,
  Home,
  LogOut,
  ReceiptText,
  RefreshCw,
  Settings,
  ShoppingBag,
  Utensils,
  UserRound,
  Users,
} from 'lucide-react';
import { useLocale, useTranslations } from 'use-intl';
import type { Language } from '@/lib/i18n/languages';
import { parseDbTimestamp } from '@/lib/utils';

export type StaffFontSize = 'small' | 'normal' | 'large';

type ProfileData = {
  business_date: string;
  timezone: string;
  attendance: {
    business_date: string;
    clock_in_at: string;
    clock_out_at: string | null;
  }[];
  summary: { sales: number; bills: number; guests: number };
};

type Panel = 'profile' | 'personal' | 'tables' | 'sales' | 'preferences' | 'history';

const card = 'rounded-2xl border-2 border-border bg-card p-4';
const action =
  'flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-xl px-3 text-base font-semibold';
const accentText = 'text-blue-800 dark:text-blue-300';
const accentSoft = 'bg-blue-50 dark:bg-blue-950/50';
const choice = (selected: boolean) =>
  `${action} border-2 text-lg ${selected ? `border-blue-800 dark:border-blue-300 ${accentSoft} ${accentText}` : 'border-border bg-background'}`;

export function StaffProfile({
  api,
  user,
  tables,
  language,
  onLanguage,
  dark,
  onDark,
  fontSize,
  onFontSize,
  formatMoney,
  onClose,
  onOrders,
  onTable,
  onLogout,
}: {
  api: AxiosInstance | null;
  user: { id: string; name: string; role: string; email: string };
  tables: {
    id: string;
    name?: string;
    number?: string;
    status?: string;
    backup_user_id?: string | null;
  }[];
  language: Language;
  onLanguage: (language: Language) => void;
  dark: boolean;
  onDark: () => void;
  fontSize: StaffFontSize;
  onFontSize: (size: StaffFontSize) => void;
  formatMoney: (amount: number) => string;
  onClose: () => void;
  onOrders: () => void;
  onTable: (id?: string) => void;
  onLogout: () => void;
}) {
  const t = useTranslations('staffProfile');
  const staff = useTranslations('staff');
  const locale = useLocale();
  const [panel, setPanel] = useState<Panel>('profile');
  const [snapshot, setSnapshot] = useState<ProfileData | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
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
  const tiles = [
    { id: 'personal', icon: UserRound, detail: t('personalHint') },
    {
      id: 'tables',
      icon: Utensils,
      detail: t('tableCount', { count: tables.length }),
    },
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
  const tableList = (
    <section className={card}>
      {sectionHeader(
        `${t('tables')} (${t('tableCount', { count: tables.length })})`,
        viewAll('tables'),
      )}
      {tables.length === 0 ? (
        <p className="text-lg text-muted-foreground">{t('noTables')}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 min-[400px]:grid-cols-4">
            {[...tables]
              .sort((a, b) =>
                String(a.name ?? a.number).localeCompare(String(b.name ?? b.number), undefined, {
                  numeric: true,
                }),
              )
              .map((table) => {
                const available = table.status === 'available';
                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => onTable(table.id)}
                    className={`flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 px-1 text-xl font-bold ${available ? 'border-green-700 bg-background dark:border-green-400' : 'border-border bg-muted'}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-3 shrink-0 rounded-full ${available ? 'bg-green-700 dark:bg-green-400' : 'bg-muted-foreground'}`}
                    />
                    <span className="truncate">{table.name ?? table.number}</span>
                    <span className="sr-only">{t(available ? 'tableAvailable' : 'tableBusy')}</span>
                  </button>
                );
              })}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-base" aria-hidden="true">
            <span className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-green-700 dark:bg-green-400" />
              {t('tableAvailable')}
            </span>
            <span className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-muted-foreground" />
              {t('tableBusy')}
            </span>
          </div>
        </>
      )}
    </section>
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
              <section className={`flex items-center gap-4 ${card}`}>
                <div
                  className={`grid size-20 shrink-0 place-items-center rounded-full text-3xl font-bold ${accentSoft} ${accentText}`}
                  aria-hidden="true"
                >
                  {Array.from(user.name.trim()).slice(0, 2).join('')}
                </div>
                <div className="min-w-0">
                  <h2 className="break-words text-2xl font-bold">{user.name}</h2>
                  <p className="text-lg text-muted-foreground">{role}</p>
                  {active && (
                    <p className="mt-2 inline-flex items-center gap-2 rounded-full border-2 border-green-700 px-3 py-1 text-base font-semibold text-green-800 dark:border-green-400 dark:text-green-300">
                      <span className="size-3 rounded-full bg-green-700 dark:bg-green-400" />
                      {t('working')}
                    </p>
                  )}
                </div>
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
              {tableList}
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
          {panel === 'tables' && tableList}
          {panel === 'sales' && summary}
          {panel === 'history' && history}
          {panel === 'preferences' && (
            <section className={`space-y-6 ${card}`}>
              <div>
                <p className="mb-2 text-lg font-bold">{t('fontSize')}</p>
                <div className="grid grid-cols-3 gap-2">
                  {(['small', 'normal', 'large'] as const).map((size) => (
                    <button
                      type="button"
                      key={size}
                      aria-pressed={fontSize === size}
                      onClick={() => onFontSize(size)}
                      className={choice(fontSize === size)}
                    >
                      {t(size)}
                      <span
                        aria-hidden="true"
                        className={
                          size === 'small'
                            ? 'text-base'
                            : size === 'normal'
                              ? 'text-xl'
                              : 'text-2xl'
                        }
                      >
                        A
                      </span>
                    </button>
                  ))}
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
