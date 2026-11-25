'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'use-intl';

export type WorkCalendarData = { since: string; work_days: string[]; absent_days: string[] };

const monthKey = (date: string) => date.slice(0, 7);
const shiftMonth = (key: string, by: number) => {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + by, 1)).toISOString().slice(0, 7);
};

const tone = {
  work: 'border-green-600 bg-green-500 text-white',
  absent: 'border-orange-500 bg-orange-500 text-white',
  off: 'border-border bg-white text-gray-900 dark:bg-background dark:text-foreground',
  future: 'border-transparent bg-transparent text-muted-foreground/60',
} as const;

/** A month of business days: worked green, off white, absent or on leave orange. */
export function StaffWorkCalendar({
  calendar,
  businessDate,
}: {
  calendar: WorkCalendarData;
  businessDate: string;
}) {
  const t = useTranslations('staffProfile');
  const locale = useLocale();
  const last = monthKey(businessDate);
  const first = monthKey(calendar.since);
  const [month, setMonth] = useState(last);
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const lead = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const worked = new Set(calendar.work_days);
  const absent = new Set(calendar.absent_days);
  const kindOf = (date: string) =>
    date > businessDate
      ? 'future'
      : worked.has(date)
        ? 'work'
        : absent.has(date)
          ? 'absent'
          : 'off';
  const dates = Array.from(
    { length: days },
    (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`,
  );
  const count = (kind: keyof typeof tone) => dates.filter((date) => kindOf(date) === kind).length;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  const title = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  const navButton =
    'grid size-11 place-items-center rounded-full border-2 border-border disabled:opacity-30';

  return (
    <div data-testid="staff-work-calendar" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={navButton}
          disabled={month <= first}
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label={t('previousMonth')}
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <h3 className="text-xl font-bold" data-testid="staff-work-calendar-month">
          {title}
        </h3>
        <button
          type="button"
          className={navButton}
          disabled={month >= last}
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label={t('nextMonth')}
        >
          <ChevronRight size={22} aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="text-sm font-semibold text-muted-foreground">
            {weekday.format(new Date(Date.UTC(2024, 0, 7 + i)))}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {dates.map((date) => {
          const kind = kindOf(date);
          return (
            <span
              key={date}
              data-date={date}
              data-day-kind={kind}
              className={`grid aspect-square place-items-center rounded-lg border-2 text-base font-semibold tabular-nums ${tone[kind]} ${date === businessDate ? 'ring-2 ring-orange-600 ring-offset-1' : ''}`}
            >
              {Number(date.slice(8))}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-base">
        {(['work', 'off', 'absent'] as const).map((kind) => (
          <span key={kind} className="flex items-center gap-2">
            <span className={`size-4 rounded border-2 ${tone[kind]}`} aria-hidden="true" />
            {t(
              kind === 'work' ? 'calendarWork' : kind === 'off' ? 'calendarOff' : 'calendarAbsent',
            )}
            <b className="tabular-nums">{count(kind)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
