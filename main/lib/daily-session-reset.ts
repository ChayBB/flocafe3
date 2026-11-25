const PART_TYPES = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

function zonedParts(
  epochMs: number,
  timeZone: string,
): Record<(typeof PART_TYPES)[number], number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function offsetAt(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(epochMs / 1000) * 1000
  );
}

function wallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
  minute = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/** Epoch seconds of the next `hour`:`minute` wall-clock time in `timeZone`, strictly after `now`. */
export function nextDailyResetEpochSeconds(
  now: Date,
  timeZone: string,
  hour = 6,
  minute = 0,
): number {
  const today = zonedParts(now.getTime(), timeZone);
  let reset = wallClockToEpoch(today.year, today.month, today.day, hour, timeZone, minute);
  if (reset <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    reset = wallClockToEpoch(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      timeZone,
      minute,
    );
  }
  return Math.floor(reset / 1000);
}
