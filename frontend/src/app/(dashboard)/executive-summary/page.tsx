'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import {
  ArrowDownRight,
  ArrowUpRight,
  Armchair,
  ChefHat,
  Lightbulb,
  Minus,
  ChartPie,
  ReceiptText,
  TrendingUp,
  Trophy,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';
import { businessDateForInstant } from '@shared/business-date';
import {
  Donut,
  Gauge,
  HourBars,
  OTHER_CLASSES,
  SERIES_CLASSES,
  TrendChart,
  type DonutSlice,
  type TrendPoint,
} from '@/components/executive-summary/charts';

type CompareMode = 'previous_period' | 'previous_month' | 'previous_year' | 'none';
type Granularity = 'daily' | 'weekly' | 'monthly';

interface AmountKpi {
  value: number;
  previous: number | null;
  changePercent: number | null;
}
interface RateKpi {
  value: number | null;
  previous: number | null;
  changePoints: number | null;
}
interface TrendBucket {
  date?: string;
  startDate?: string;
  endDate?: string;
  sales: number;
  bills: number;
}
interface ItemRow {
  productId: string;
  name: string;
  quantity: number;
  sales: number;
  salesPercent: number | null;
  quantityPercent: number | null;
}
interface Insight {
  code: string;
  tone: 'positive' | 'negative' | 'action';
  params: Record<string, string | number>;
}
interface ExecutiveSummary {
  range: { startDate: string; endDate: string; days: number };
  compare: { mode: CompareMode; startDate: string; endDate: string; days: number } | null;
  financialsIncluded: boolean;
  kpis: {
    sales: AmountKpi;
    bills: AmountKpi;
    guests: AmountKpi & { estimated: boolean };
    averageOrderValue: AmountKpi;
    tableUtilisation: RateKpi | null;
    grossMargin: (RateKpi & { costStatus: 'known' | 'partial' | 'unknown' }) | null;
  };
  trend: Record<Granularity, { current: TrendBucket[]; previous: TrendBucket[] }>;
  categories: {
    name: string | null;
    sales: number;
    quantity: number;
    salesPercent: number | null;
  }[];
  topItems: { byRevenue: ItemRow[]; byQuantity: ItemRow[] };
  operations: {
    orders: number;
    cancelledOrders: number;
    cancelPercent: number | null;
    timedOrders: number;
    avgWaitMinutes: number | null;
    avgPrepMinutes: number | null;
    onTimePercent: number | null;
    onTimeMinutes: number;
    previous: {
      cancelPercent: number | null;
      avgWaitMinutes: number | null;
      avgPrepMinutes: number | null;
      onTimePercent: number | null;
    } | null;
  };
  tables: {
    count: number;
    utilisationPercent: number | null;
    byHour: { hour: number; percent: number }[];
    peakHours: number[];
    seatingsPerTablePerDay: number | null;
  } | null;
  customers: {
    guests: number;
    guestsEstimated: boolean;
    totalMembers: number;
    newMembers: number;
    memberVisits: number;
    returningMembers: number;
    memberOrderPercent: number | null;
    previous: { newMembers: number; memberVisits: number; returningMembers: number } | null;
  };
  financial: {
    sales: number;
    tax: number;
    salesExTax: number;
    foodCost: number | null;
    foodCostPercent: number | null;
    costStatus: 'known' | 'partial' | 'unknown';
    labour: { cost: number; hours: number; complete: boolean };
    expenses: { total: number; categories: { name: string; amount: number }[] };
    estimatedProfit: number;
    previous: {
      sales: number;
      foodCost: number | null;
      labour: number;
      expenses: number;
      estimatedProfit: number;
    } | null;
  } | null;
  hourly: { date: string; hours: { hour: number; sales: number; bills: number }[] };
  staff: {
    userId: string;
    name: string;
    role: string | null;
    orders: number;
    sales: number;
    averageOrderValue: number | null;
    hours: number;
    salesPerHour: number | null;
    wage?: number;
  }[];
  insights: Insight[];
}

const MAX_RANGE_DAYS = 93;
const CATEGORY_SLICES = 5;
const INPUT_CLASS =
  'h-10 rounded-xl border border-border bg-card ps-3 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-brand/30';

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function monthStart(date: string, monthsBack = 0): string {
  const [year, month] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 - monthsBack, 1));
  return value.toISOString().slice(0, 10);
}

function monthEnd(start: string): string {
  const [year, month] = start.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function Section({
  title,
  icon: Icon,
  action,
  children,
  className = '',
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-card p-5 shadow-sm ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon size={16} />
          </span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      className="flex rounded-lg border border-border bg-background p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${value === option.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default function ExecutiveSummaryPage() {
  const t = useTranslations('executiveSummary');
  const tCommon = useTranslations('common');
  const tStaff = useTranslations('staff');
  const locale = useLocale();
  const router = useRouter();
  const { currentTenant } = useAuthStore();
  const canView = tenantCan(currentTenant, 'reports.view');
  const fmt = useFormatCurrency();
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = businessDateForInstant({
    instant: new Date(),
    timezone: timeZone,
    startTime: currentTenant?.business_day_start_time || '00:00',
  });
  const [startDate, setStartDate] = useState(() => monthStart(today));
  const [endDate, setEndDate] = useState(today);
  const [compare, setCompare] = useState<CompareMode>('previous_month');
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [itemMode, setItemMode] = useState<'revenue' | 'quantity'>('revenue');
  const [data, setData] = useState<ExecutiveSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const number = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    [locale],
  );
  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    [locale],
  );
  const fmtDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  const fmtHour = (hour: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2000, 0, 1, hour)));
  const pct = (value: number | null) => (value === null ? '—' : `${number.format(value)}%`);

  useEffect(() => {
    if (currentTenant && !canView) router.replace('/pos');
  }, [currentTenant, canView, router]);

  const requestKey = `${startDate}:${endDate}:${compare}`;
  const [loadedKey, setLoadedKey] = useState(requestKey);
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey);
    setLoading(true);
  }

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    api
      .get('/reports/executive-summary', {
        params: { start_date: startDate, end_date: endDate, compare },
        signal: controller.signal,
      })
      .then((res) => setData(res.data.executiveSummary))
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))
          return;
        toast.error(tCommon('somethingWrong'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, startDate, endDate, compare]);

  const setRange = (start: string, end: string) => {
    setStartDate(start);
    setEndDate(end > today ? today : end);
  };
  const handleStart = (value: string) => {
    if (!value) return;
    let end = endDate;
    if (value > end) end = value;
    if (shiftDate(value, MAX_RANGE_DAYS - 1) < end) end = shiftDate(value, MAX_RANGE_DAYS - 1);
    setRange(value, end);
  };
  const handleEnd = (value: string) => {
    if (!value) return;
    let start = startDate;
    if (value < start) start = value;
    if (shiftDate(value, -(MAX_RANGE_DAYS - 1)) > start)
      start = shiftDate(value, -(MAX_RANGE_DAYS - 1));
    setRange(start, value);
  };
  const presets = [
    { key: 'presetThisMonth', start: monthStart(today), end: today },
    { key: 'presetLastMonth', start: monthStart(today, 1), end: monthEnd(monthStart(today, 1)) },
    { key: 'presetLast7', start: shiftDate(today, -6), end: today },
    { key: 'presetLast30', start: shiftDate(today, -29), end: today },
  ] as const;

  const trendPoints: TrendPoint[] = useMemo(() => {
    if (!data) return [];
    const series = data.trend[granularity];
    const label = (bucket: TrendBucket) => {
      const date = bucket.date ?? bucket.startDate ?? '';
      if (granularity === 'monthly') return monthFormat.format(new Date(`${date}T00:00:00Z`));
      return fmtDate(date);
    };
    const longLabel = (bucket: TrendBucket) =>
      granularity === 'weekly' ? t('weekOf', { date: label(bucket) }) : label(bucket);
    const length = Math.max(series.current.length, data.compare ? series.previous.length : 0);
    return Array.from({ length }, (_, i) => {
      const current = series.current[i];
      const previous = series.previous[i];
      return {
        label: current ? label(current) : '',
        current: current ? current.sales : null,
        previous: previous ? previous.sales : null,
        currentLabel: current ? longLabel(current) : '',
        previousLabel: previous ? longLabel(previous) : null,
      };
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [data, granularity, locale]);

  if (!canView) return null;

  const compareOptions: { value: CompareMode; label: string }[] = [
    { value: 'previous_period', label: t('comparePreviousPeriod') },
    { value: 'previous_month', label: t('comparePreviousMonth') },
    { value: 'previous_year', label: t('comparePreviousYear') },
    { value: 'none', label: t('compareNone') },
  ];

  const change = (kpi: { changePercent?: number | null; changePoints?: number | null }) => {
    const value = kpi.changePercent ?? kpi.changePoints ?? null;
    if (!data?.compare) return null;
    if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
    const up = value > 0;
    const Icon = value === 0 ? Minus : up ? ArrowUpRight : ArrowDownRight;
    const tone =
      value === 0
        ? 'bg-muted text-muted-foreground'
        : up
          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300';
    const text =
      kpi.changePoints !== undefined
        ? t('pointsChange', { value: `${up ? '+' : ''}${number.format(value)}` })
        : `${up ? '+' : ''}${number.format(value)}%`;
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
      >
        <Icon size={12} />
        <span dir="ltr">{text}</span>
      </span>
    );
  };

  const kpiTiles = data
    ? [
        {
          key: 'sales',
          label: t('kpiSales'),
          value: fmt(data.kpis.sales.value),
          kpi: data.kpis.sales,
          previous: data.kpis.sales.previous === null ? null : fmt(data.kpis.sales.previous),
          note: null,
        },
        {
          key: 'bills',
          label: t('kpiBills'),
          value: number.format(data.kpis.bills.value),
          kpi: data.kpis.bills,
          previous:
            data.kpis.bills.previous === null ? null : number.format(data.kpis.bills.previous),
          note: null,
        },
        {
          key: 'guests',
          label: t('kpiGuests'),
          value: number.format(data.kpis.guests.value),
          kpi: data.kpis.guests,
          previous:
            data.kpis.guests.previous === null ? null : number.format(data.kpis.guests.previous),
          note: data.kpis.guests.estimated ? t('kpiGuestsEstimated') : null,
        },
        {
          key: 'aov',
          label: t('kpiAov'),
          value: fmt(data.kpis.averageOrderValue.value),
          kpi: data.kpis.averageOrderValue,
          previous:
            data.kpis.averageOrderValue.previous === null
              ? null
              : fmt(data.kpis.averageOrderValue.previous),
          note: null,
        },
        ...(data.kpis.tableUtilisation
          ? [
              {
                key: 'tables',
                label: t('kpiTableUse'),
                value: pct(data.kpis.tableUtilisation.value),
                kpi: data.kpis.tableUtilisation,
                previous:
                  data.kpis.tableUtilisation.previous === null
                    ? null
                    : pct(data.kpis.tableUtilisation.previous),
                note: null,
              },
            ]
          : []),
        ...(data.kpis.grossMargin
          ? [
              {
                key: 'margin',
                label: t('kpiGrossMargin'),
                value: pct(data.kpis.grossMargin.value),
                kpi: data.kpis.grossMargin,
                previous:
                  data.kpis.grossMargin.previous === null
                    ? null
                    : pct(data.kpis.grossMargin.previous),
                note: data.kpis.grossMargin.costStatus === 'partial' ? t('marginPartial') : null,
              },
            ]
          : []),
      ]
    : [];

  const slices: DonutSlice[] = data
    ? (() => {
        const head = data.categories.slice(0, CATEGORY_SLICES);
        const rest = data.categories.slice(CATEGORY_SLICES);
        const list: DonutSlice[] = head.map((c, i) => ({
          key: c.name ?? '',
          label: c.name ?? t('uncategorized'),
          value: c.sales,
          percent: c.salesPercent,
          colorIndex: i,
        }));
        if (rest.length > 0)
          list.push({
            key: '__other',
            label: t('otherCategories'),
            value: rest.reduce((sum, c) => sum + c.sales, 0),
            percent: rest.reduce((sum, c) => sum + (c.salesPercent ?? 0), 0),
            colorIndex: null,
          });
        return list;
      })()
    : [];
  const itemSalesTotal = data ? data.categories.reduce((sum, c) => sum + c.sales, 0) : 0;
  const items = data
    ? itemMode === 'revenue'
      ? data.topItems.byRevenue
      : data.topItems.byQuantity
    : [];
  const itemMax = Math.max(1, ...items.map((i) => (itemMode === 'revenue' ? i.sales : i.quantity)));
  const hourBars = data
    ? (() => {
        const active = data.hourly.hours
          .filter((h) => h.sales !== 0 || h.bills > 0)
          .map((h) => h.hour);
        if (active.length === 0) return [];
        const from = Math.min(...active);
        const to = Math.max(...active);
        return data.hourly.hours
          .filter((h) => h.hour >= from && h.hour <= to)
          .map((h) => ({
            hour: h.hour,
            value: h.sales,
            detail: t('billCount', { count: h.bills }),
          }));
      })()
    : [];
  const insightText = (insight: Insight) => {
    const params = { ...insight.params };
    if (insight.code === 'peakHour') params.hour = fmtHour(Number(params.hour));
    if (typeof params.percent === 'number') params.percent = number.format(params.percent);
    const key = `insight${insight.code[0].toUpperCase()}${insight.code.slice(1)}`;
    return t.has(key as never) ? t(key as never, params as never) : null;
  };

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 lg:p-7">
      <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('subtitle', { start: fmtDate(startDate), end: fmtDate(endDate) })}
            {data?.compare && (
              <span className="ms-2">
                ·{' '}
                {t('vsRange', {
                  start: fmtDate(data.compare.startDate),
                  end: fmtDate(data.compare.endDate),
                })}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-2 xl:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <DatePickerInput
              type="date"
              value={startDate}
              max={today}
              onChange={(e) => handleStart(e.target.value)}
              className={INPUT_CLASS}
              buttonClassName="rounded-e-xl"
              aria-label={t('periodStart')}
              pickerAriaLabel={t('openDatePicker')}
            />
            <DatePickerInput
              type="date"
              value={endDate}
              min={startDate}
              max={today}
              onChange={(e) => handleEnd(e.target.value)}
              className={INPUT_CLASS}
              buttonClassName="rounded-e-xl"
              aria-label={t('periodEnd')}
              pickerAriaLabel={t('openDatePicker')}
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="whitespace-nowrap">{t('compareWith')}</span>
              <select
                value={compare}
                onChange={(e) => setCompare(e.target.value as CompareMode)}
                className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
              >
                {compareOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('presets')}>
            {presets.map((preset) => {
              const active = preset.start === startDate && preset.end === endDate;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => setRange(preset.start, preset.end)}
                  aria-pressed={active}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:bg-muted'}`}
                >
                  {t(preset.key)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div
          className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6"
          role="status"
          aria-live="polite"
        >
          <span className="sr-only">{tCommon('loading')}</span>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-32 animate-pulse rounded-2xl border border-border bg-card/70"
            />
          ))}
        </div>
      ) : data ? (
        <div
          className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}
          aria-busy={loading}
        >
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-6">
            {kpiTiles.map((tile) => (
              <div
                key={tile.key}
                className="rounded-2xl border border-border bg-card p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground sm:text-sm">
                    {tile.label}
                  </span>
                  {change(tile.kpi)}
                </div>
                <div className="mt-2 truncate text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
                  {tile.value}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {data.compare && tile.previous !== null
                    ? t('previousValue', { value: tile.previous })
                    : data.compare
                      ? ''
                      : t('noComparison')}
                </div>
                {tile.note && (
                  <div className="mt-1 text-[11px] text-muted-foreground">{tile.note}</div>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <Section
              title={t('trendTitle')}
              icon={TrendingUp}
              className="xl:col-span-2"
              action={
                <Segmented
                  label={t('trendTitle')}
                  value={granularity}
                  onChange={setGranularity}
                  options={[
                    { value: 'daily', label: t('daily') },
                    { value: 'weekly', label: t('weekly') },
                    { value: 'monthly', label: t('monthly') },
                  ]}
                />
              }
            >
              <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block h-0.5 w-4 ${SERIES_CLASSES[0].bg}`} />
                  {t('currentPeriod')}
                </span>
                {data.compare && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-4 border-t-2 border-dashed border-muted-foreground/60" />
                    {t('previousPeriod')}
                  </span>
                )}
              </div>
              <TrendChart
                points={trendPoints}
                format={fmt}
                currentName={t('currentPeriod')}
                previousName={data.compare ? t('previousPeriod') : null}
              />
            </Section>

            <Section title={t('categoryTitle')} icon={ChartPie}>
              {slices.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('noSales')}</p>
              ) : (
                <div className="flex flex-col items-center gap-4 sm:flex-row xl:flex-col 2xl:flex-row">
                  <Donut
                    slices={slices}
                    centerLabel={t('itemSales')}
                    centerValue={fmt(itemSalesTotal)}
                  />
                  <ul className="w-full space-y-2 text-sm">
                    {slices.map((slice) => (
                      <li key={slice.key} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`size-2.5 shrink-0 rounded-sm ${slice.colorIndex === null ? OTHER_CLASSES.bg : SERIES_CLASSES[slice.colorIndex].bg}`}
                          />
                          <span className="truncate text-foreground">{slice.label}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {pct(slice.percent === null ? null : Math.round(slice.percent * 10) / 10)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
            <Section
              title={t('topItemsTitle')}
              icon={Trophy}
              action={
                <Segmented
                  label={t('topItemsTitle')}
                  value={itemMode}
                  onChange={setItemMode}
                  options={[
                    { value: 'revenue', label: t('byRevenue') },
                    { value: 'quantity', label: t('byQuantity') },
                  ]}
                />
              }
            >
              {items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('noSales')}</p>
              ) : (
                <ol className="space-y-3">
                  {items.map((item, index) => {
                    const value = itemMode === 'revenue' ? item.sales : item.quantity;
                    return (
                      <li key={item.productId}>
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="min-w-0 truncate text-foreground">
                            <span className="me-2 text-muted-foreground tabular-nums">
                              {index + 1}
                            </span>
                            {item.name}
                          </span>
                          <span className="shrink-0 font-medium tabular-nums text-foreground">
                            {itemMode === 'revenue'
                              ? fmt(item.sales)
                              : t('soldCount', { count: item.quantity })}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${SERIES_CLASSES[0].bg}`}
                            style={{ width: `${(value / itemMax) * 100}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Section>

            <Section title={t('operationsTitle')} icon={ChefHat}>
              <dl className="grid grid-cols-2 gap-3">
                {[
                  {
                    label: t('avgWait'),
                    value:
                      data.operations.avgWaitMinutes === null
                        ? '—'
                        : t('minutesValue', {
                            value: number.format(data.operations.avgWaitMinutes),
                          }),
                  },
                  {
                    label: t('avgPrep'),
                    value:
                      data.operations.avgPrepMinutes === null
                        ? '—'
                        : t('minutesValue', {
                            value: number.format(data.operations.avgPrepMinutes),
                          }),
                  },
                  {
                    label: t('onTime', { minutes: data.operations.onTimeMinutes }),
                    value: pct(data.operations.onTimePercent),
                  },
                  {
                    label: t('cancelRate'),
                    value: pct(data.operations.cancelPercent),
                    sub: t('cancelCount', {
                      count: data.operations.cancelledOrders,
                      total: data.operations.orders,
                    }),
                  },
                ].map((metric) => (
                  <div key={metric.label} className="rounded-xl bg-muted/50 p-3">
                    <dt className="text-xs text-muted-foreground">{metric.label}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                      {metric.value}
                    </dd>
                    {metric.sub && (
                      <dd className="text-[11px] text-muted-foreground">{metric.sub}</dd>
                    )}
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                {data.operations.timedOrders > 0
                  ? t('timedOrders', { count: data.operations.timedOrders })
                  : t('noKitchenData')}
              </p>
            </Section>

            {data.tables && (
              <Section title={t('tablesTitle')} icon={Armchair}>
                {data.tables.utilisationPercent === null ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t('noTableData')}
                  </p>
                ) : (
                  <>
                    <Gauge
                      percent={data.tables.utilisationPercent}
                      label={pct(data.tables.utilisationPercent)}
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      {t('tablesCaption')}
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl bg-muted/50 p-3">
                        <div className="text-xs text-muted-foreground">{t('peakHours')}</div>
                        <div className="mt-1 font-semibold tabular-nums text-foreground">
                          {data.tables.peakHours.length > 0
                            ? data.tables.peakHours.map(fmtHour).join(', ')
                            : '—'}
                        </div>
                      </div>
                      <div className="rounded-xl bg-muted/50 p-3">
                        <div className="text-xs text-muted-foreground">{t('seatingsPerTable')}</div>
                        <div className="mt-1 font-semibold tabular-nums text-foreground">
                          {data.tables.seatingsPerTablePerDay === null
                            ? '—'
                            : number.format(data.tables.seatingsPerTablePerDay)}
                        </div>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('tableCount', { count: data.tables.count })}
                    </p>
                  </>
                )}
              </Section>
            )}

            <Section title={t('customersTitle')} icon={Users}>
              <dl className="grid grid-cols-2 gap-3">
                {[
                  { label: t('guests'), value: number.format(data.customers.guests) },
                  { label: t('newMembers'), value: number.format(data.customers.newMembers) },
                  { label: t('memberVisits'), value: number.format(data.customers.memberVisits) },
                  {
                    label: t('returningMembers'),
                    value: number.format(data.customers.returningMembers),
                  },
                  { label: t('memberOrderShare'), value: pct(data.customers.memberOrderPercent) },
                  { label: t('totalMembers'), value: number.format(data.customers.totalMembers) },
                ].map((metric) => (
                  <div key={metric.label} className="rounded-xl bg-muted/50 p-3">
                    <dt className="text-xs text-muted-foreground">{metric.label}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                      {metric.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>

            {data.financial && (
              <Section title={t('financialTitle')} icon={Wallet}>
                <table className="w-full text-sm">
                  <tbody>
                    {[
                      { label: t('finSales'), value: data.financial.sales },
                      { label: t('finTax'), value: data.financial.tax },
                      { label: t('finFoodCost'), value: data.financial.foodCost },
                      { label: t('finLabour'), value: data.financial.labour.cost },
                      { label: t('finExpenses'), value: data.financial.expenses.total },
                    ].map((row) => (
                      <tr key={row.label} className="border-b border-border/60">
                        <td className="py-2 text-muted-foreground">{row.label}</td>
                        <td className="py-2 text-end tabular-nums text-foreground">
                          {row.value === null ? '—' : fmt(row.value)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="pt-3 font-semibold text-foreground">{t('finProfit')}</td>
                      <td
                        className={`pt-3 text-end text-lg font-semibold tabular-nums ${data.financial.estimatedProfit < 0 ? 'text-red-700 dark:text-red-400' : 'text-foreground'}`}
                      >
                        {fmt(data.financial.estimatedProfit)}
                      </td>
                    </tr>
                    {data.financial.previous && (
                      <tr>
                        <td />
                        <td className="text-end text-xs text-muted-foreground">
                          {t('previousValue', {
                            value: fmt(data.financial.previous.estimatedProfit),
                          })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <div className="mt-3 space-y-1 text-xs text-amber-800 dark:text-amber-300">
                  {data.financial.costStatus === 'partial' && <p>{t('finCostPartial')}</p>}
                  {data.financial.costStatus === 'unknown' && <p>{t('finCostUnknown')}</p>}
                  {!data.financial.labour.complete && <p>{t('finLabourIncomplete')}</p>}
                </div>
              </Section>
            )}

            <Section
              title={t('hourlyTitle')}
              icon={ReceiptText}
              action={
                <span className="text-xs text-muted-foreground">{fmtDate(data.hourly.date)}</span>
              }
            >
              {hourBars.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('noHourly')}</p>
              ) : (
                <HourBars bars={hourBars} format={fmt} hourLabel={fmtHour} />
              )}
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <Section title={t('staffTitle')} icon={UserRound} className="xl:col-span-2">
              {data.staff.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('noStaff')}</p>
              ) : (
                <div className="-mx-5 overflow-x-auto px-5">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="py-2 text-start font-medium">{t('staffName')}</th>
                        <th className="py-2 text-end font-medium">{t('staffOrders')}</th>
                        <th className="py-2 text-end font-medium">{t('staffSales')}</th>
                        <th className="py-2 text-end font-medium">{t('staffAov')}</th>
                        <th className="py-2 text-end font-medium">{t('staffHours')}</th>
                        <th className="py-2 text-end font-medium">{t('staffSalesPerHour')}</th>
                        {data.financialsIncluded && (
                          <th className="py-2 text-end font-medium">{t('staffWage')}</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.staff.map((row) => {
                        const roleKey = row.role ? ROLE_LABEL_KEYS[row.role] : undefined;
                        return (
                          <tr key={row.userId} className="border-b border-border/60 last:border-0">
                            <td className="py-2">
                              <div className="font-medium text-foreground">{row.name}</div>
                              {roleKey && (
                                <div className="text-xs text-muted-foreground">
                                  {tStaff(roleKey)}
                                </div>
                              )}
                            </td>
                            <td className="py-2 text-end tabular-nums">
                              {number.format(row.orders)}
                            </td>
                            <td className="py-2 text-end tabular-nums">{fmt(row.sales)}</td>
                            <td className="py-2 text-end tabular-nums">
                              {row.averageOrderValue === null ? '—' : fmt(row.averageOrderValue)}
                            </td>
                            <td className="py-2 text-end tabular-nums">
                              {number.format(row.hours)}
                            </td>
                            <td className="py-2 text-end tabular-nums">
                              {row.salesPerHour === null ? '—' : fmt(row.salesPerHour)}
                            </td>
                            {data.financialsIncluded && (
                              <td className="py-2 text-end tabular-nums">{fmt(row.wage ?? 0)}</td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title={t('summaryTitle')} icon={Lightbulb}>
              {data.insights.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('noInsights')}</p>
              ) : (
                <ul className="space-y-2.5 text-sm">
                  {data.insights.map((insight) => {
                    const text = insightText(insight);
                    if (!text) return null;
                    const Icon =
                      insight.tone === 'positive'
                        ? ArrowUpRight
                        : insight.tone === 'negative'
                          ? ArrowDownRight
                          : Lightbulb;
                    const tone =
                      insight.tone === 'positive'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : insight.tone === 'negative'
                          ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300';
                    return (
                      <li key={insight.code} className="flex gap-2.5">
                        <span
                          className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md ${tone}`}
                        >
                          <Icon size={14} />
                        </span>
                        <span className="text-foreground">{text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
