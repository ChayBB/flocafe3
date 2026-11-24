'use client';

import { useEffect, useState } from 'react';
import type { AxiosInstance } from 'axios';
import {
  ArrowLeft,
  BarChart3,
  CalendarDays,
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
  attendance: { business_date: string; clock_in_at: string; clock_out_at: string | null }[];
  summary: { sales: number; bills: number; guests: number };
};

type Panel = 'profile' | 'personal' | 'tables' | 'sales' | 'leave' | 'preferences' | 'history';

export function StaffProfile({
  api,
  user,
  tables,
  coverUrl,
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
  coverUrl: string;
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
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.get<ProfileData>('/api/staff-profile').then(
      ({ data }) => {
        if (!cancelled) setSnapshot(data);
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
  const formatTime = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: snapshot?.timezone,
        }).format(parseDbTimestamp(value))
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
    { id: 'tables', icon: Utensils, detail: t('tableCount', { count: tables.length }) },
    { id: 'sales', icon: BarChart3, detail: snapshot ? formatMoney(snapshot.summary.sales) : '—' },
    { id: 'leave', icon: CalendarDays, detail: t('leaveHint') },
    { id: 'preferences', icon: Settings, detail: t('preferencesHint') },
    { id: 'history', icon: Clock, detail: t('historyHint') },
  ] as const;
  const card = 'rounded-2xl border border-border bg-card p-4 shadow-sm';
  const action = 'flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium';

  const summary = (
    <section className={card}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-bold">{t('todaySummary')}</h2>
        <button
          type="button"
          className={action}
          aria-label={t('refresh')}
          onClick={() => {
            setFailed(false);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={18} className="text-teal-600" />
        </button>
      </div>
      {failed && (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          {t('summaryUnavailable')}
        </p>
      )}
      <div className="grid grid-cols-3 gap-2 text-center">
        {(
          [
            [
              ShoppingBag,
              'sales',
              snapshot && formatMoney(snapshot.summary.sales),
              'bg-teal-500/10 text-teal-700 dark:text-teal-300',
            ],
            [
              ReceiptText,
              'bills',
              snapshot?.summary.bills,
              'bg-sky-500/10 text-sky-700 dark:text-sky-300',
            ],
            [
              Users,
              'guests',
              snapshot?.summary.guests,
              'bg-violet-500/10 text-violet-700 dark:text-violet-300',
            ],
          ] as const
        ).map(([Metric, label, value, color]) => {
          return (
            <div key={String(label)} className={`min-w-0 rounded-xl p-2 ${color}`}>
              <Metric className="mx-auto mb-1" size={22} />
              <p className="text-xs font-medium">{t(label)}</p>
              <p className="break-words font-bold tabular-nums" dir="auto">
                {value ?? '—'}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
  const tableList = (
    <section className={card}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-bold">
          {t('tables')}{' '}
          <small className="font-normal">{t('tableCount', { count: tables.length })}</small>
        </h2>
        {panel === 'profile' && (
          <button type="button" onClick={() => setPanel('tables')} className={action}>
            {t('viewAll')}
            <ChevronRight size={16} />
          </button>
        )}
      </div>
      {tables.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noTables')}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {tables.map((table) => (
            <button
              key={table.id}
              type="button"
              onClick={() => onTable(table.id)}
              className={`flex min-h-10 items-center justify-center gap-1 rounded-xl border px-1 text-sm font-semibold ${table.status === 'available' ? 'border-green-500/40 bg-green-500/10 text-green-800 dark:text-green-300' : 'border-border bg-muted'}`}
            >
              <Utensils size={14} /> <span className="truncate">{table.name ?? table.number}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
  const history = (
    <section className={card}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-bold">{panel === 'profile' ? t('todayWork') : t('history')}</h2>
        {panel === 'profile' && (
          <button type="button" onClick={() => setPanel('history')} className={action}>
            {t('viewAll')}
            <ChevronRight size={16} />
          </button>
        )}
      </div>
      {!(panel === 'profile' ? today : snapshot?.attendance.length) ? (
        <p className="text-sm text-muted-foreground">{t('noAttendance')}</p>
      ) : (
        (panel === 'profile' && today ? [today] : (snapshot?.attendance ?? [])).map((entry) => (
          <div
            key={entry.business_date}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              <Clock size={17} className="text-brand" />
              {entry.business_date}
            </span>
            <span dir="ltr" className="tabular-nums">
              {formatTime(entry.clock_in_at)} – {formatTime(entry.clock_out_at)}
            </span>
            {!entry.clock_out_at && (
              <span className="rounded-full bg-green-500/10 px-2 py-1 text-xs text-green-800 dark:text-green-300">
                {t('clockedIn')}
              </span>
            )}
          </div>
        ))
      )}
    </section>
  );

  return (
    <div data-testid="server-app-staff-profile" className="min-h-dvh bg-muted/35 text-foreground">
      <div className="mx-auto min-h-dvh max-w-lg bg-background shadow-sm">
        <header
          className={`relative flex items-center justify-between gap-3 px-4 py-4 ${panel === 'profile' ? 'min-h-32 items-start bg-neutral-900 bg-cover bg-center text-white' : 'border-b border-border'}`}
          style={
            panel === 'profile'
              ? { backgroundImage: `linear-gradient(#26130588,#261305d9),url("${coverUrl}")` }
              : undefined
          }
        >
          <button
            type="button"
            className={action}
            aria-label={t('back')}
            onClick={panel === 'profile' ? onClose : () => setPanel('profile')}
          >
            <ArrowLeft size={22} />
          </button>
          <h1 className="mt-2 flex-1 text-xl font-bold">{t(panel)}</h1>
          {panel === 'profile' && (
            <button type="button" className={action} aria-label={t('logout')} onClick={onLogout}>
              <LogOut size={20} />
            </button>
          )}
        </header>
        <main className={`relative space-y-3 px-3 pb-24 ${panel === 'profile' ? '-mt-8' : 'pt-4'}`}>
          {panel === 'profile' && (
            <>
              <section className={`flex items-center gap-4 ${card}`}>
                <div
                  className="grid size-20 shrink-0 place-items-center rounded-full bg-brand/10 text-2xl font-bold text-brand"
                  aria-hidden="true"
                >
                  {Array.from(user.name.trim()).slice(0, 2).join('')}
                </div>
                <div className="min-w-0">
                  <h2 className="break-words text-xl font-bold">{user.name}</h2>
                  <p className="text-sm text-muted-foreground">{role}</p>
                  {active && (
                    <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-1 text-xs font-semibold text-green-800 dark:text-green-300">
                      <span className="size-2 rounded-full bg-green-600" />
                      {t('working')}
                    </p>
                  )}
                </div>
              </section>
              <div className="grid grid-cols-2 gap-2">
                {tiles.map(({ id, icon: Icon, detail }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPanel(id)}
                    className={`flex min-w-0 items-center gap-2 text-start ${card}`}
                  >
                    <Icon size={23} className="shrink-0 text-brand" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold">{t(id)}</span>
                      <span className="block text-xs text-muted-foreground">{detail}</span>
                    </span>
                    <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
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
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t('name')}</dt>
                  <dd className="font-semibold">{user.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('email')}</dt>
                  <dd className="break-all font-semibold">{user.email || '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('role')}</dt>
                  <dd className="font-semibold">{role}</dd>
                </div>
              </dl>
            </section>
          )}
          {panel === 'tables' && tableList}
          {panel === 'sales' && summary}
          {panel === 'history' && history}
          {panel === 'leave' && (
            <section className={card}>
              <p className="text-sm text-muted-foreground">{t('leaveUnavailable')}</p>
            </section>
          )}
          {panel === 'preferences' && (
            <section className={`space-y-4 ${card}`}>
              <div>
                <p className="mb-2 text-sm font-semibold">{t('fontSize')}</p>
                <div className="grid grid-cols-3 gap-2">
                  {(['small', 'normal', 'large'] as const).map((size) => (
                    <button
                      type="button"
                      key={size}
                      aria-pressed={fontSize === size}
                      onClick={() => onFontSize(size)}
                      className={`${action} justify-center border ${fontSize === size ? 'border-brand bg-brand/10 text-brand' : 'border-border'}`}
                    >
                      {t(size)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold">{t('theme')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {[false, true].map((value) => (
                    <button
                      type="button"
                      key={String(value)}
                      aria-pressed={dark === value}
                      onClick={() => {
                        if (dark !== value) onDark();
                      }}
                      className={`${action} justify-center border ${dark === value ? 'border-brand bg-brand/10 text-brand' : 'border-border'}`}
                    >
                      {t(value ? 'dark' : 'light')}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block text-sm font-semibold">
                {t('language')}
                <select
                  value={language}
                  onChange={(event) => onLanguage(event.target.value as Language)}
                  className="mt-2 min-h-11 w-full rounded-xl border border-border bg-background px-3 font-normal"
                >
                  <option value="th">ไทย</option>
                  <option value="en">English</option>
                </select>
              </label>
            </section>
          )}
        </main>
        {panel === 'profile' && (
          <nav className="fixed inset-x-0 bottom-0 z-10 mx-auto grid max-w-lg grid-cols-4 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">
            {[
              { label: 'home', icon: Home, run: onClose },
              { label: 'orders', icon: ReceiptText, run: onOrders },
              { label: 'tables', icon: Utensils, run: () => onTable() },
              { label: 'profile', icon: UserRound, run: () => setPanel('profile') },
            ].map(({ label, icon: Icon, run }) => (
              <button
                key={label}
                type="button"
                onClick={run}
                aria-current={label === 'profile' ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs ${label === 'profile' ? 'font-semibold text-brand' : 'text-muted-foreground'}`}
              >
                <Icon size={20} />
                {t(label as 'home' | 'orders' | 'tables' | 'profile')}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
