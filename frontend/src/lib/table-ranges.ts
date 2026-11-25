const PLAIN_INTEGER = /^\d+$/;

/** Plain integer table names collapse into runs ("01","2","3","7" -> "1-3, 7"); other names follow in natural order. */
export function formatTableRanges(names: readonly string[]): string {
  const numbers = [
    ...new Set(names.filter((name) => PLAIN_INTEGER.test(name)).map((name) => Number(name))),
  ].sort((a, b) => a - b);
  const others = [...new Set(names.filter((name) => !PLAIN_INTEGER.test(name)))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const runs: string[] = [];
  for (let i = 0; i < numbers.length;) {
    let end = i;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end += 1;
    runs.push(end > i ? `${numbers[i]}-${numbers[end]}` : String(numbers[i]));
    i = end + 1;
  }
  return [...runs, ...others].join(', ');
}

export type TableRange = { from: string; to: string };
export type RangeTable = { id: string; label: string };

const asNumber = (value: string) =>
  PLAIN_INTEGER.test(value.trim()) ? Number(value.trim()) : null;

const byLabel = (a: RangeTable, b: RangeTable) =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

/** Tables a typed range names: every numbered table from..to, or the one table named exactly. */
export function resolveTableRange<T extends RangeTable>(
  range: TableRange,
  tables: readonly T[],
): T[] {
  const from = range.from.trim();
  const to = range.to.trim() || from;
  if (!from) return [];
  const low = asNumber(from);
  const high = asNumber(to);
  if (low !== null && high !== null) {
    const [min, max] = low <= high ? [low, high] : [high, low];
    return tables
      .filter((table) => {
        const number = asNumber(table.label);
        return number !== null && number >= min && number <= max;
      })
      .sort(byLabel);
  }
  return from === to ? tables.filter((table) => table.label.trim() === from) : [];
}

/** The fewest ranges that cover `chosen`, merging tables that sit next to each other in `all`. */
export function tablesToRanges(
  chosen: readonly RangeTable[],
  all: readonly RangeTable[],
): TableRange[] {
  const picked = new Set(chosen.map((table) => table.id));
  const ranges: TableRange[] = [];
  let run: RangeTable[] = [];
  const flush = () => {
    if (run.length) ranges.push({ from: run[0].label, to: run[run.length - 1].label });
    run = [];
  };
  for (const table of [...all].sort(byLabel)) {
    if (!picked.has(table.id)) {
      flush();
      continue;
    }
    if (asNumber(table.label) === null) {
      flush();
      ranges.push({ from: table.label, to: table.label });
      continue;
    }
    run.push(table);
  }
  flush();
  return ranges;
}

/** The run of tables just before and just after `chosen` in table order, each as long as `chosen`. */
export function neighbourRanges(
  chosen: readonly RangeTable[],
  all: readonly RangeTable[],
): { before: TableRange | null; after: TableRange | null } {
  const sorted = [...all].sort(byLabel);
  const picked = new Set(chosen.map((table) => table.id));
  const indexes = sorted.flatMap((table, index) => (picked.has(table.id) ? [index] : []));
  if (!indexes.length) return { before: null, after: null };
  const size = indexes.length;
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  const asRange = (run: RangeTable[]) =>
    run.length ? { from: run[0].label, to: run[run.length - 1].label } : null;
  return {
    before: asRange(sorted.slice(Math.max(0, first - size), first)),
    after: asRange(sorted.slice(last + 1, last + 1 + size)),
  };
}

/** Backup tables split at the main tables; each group spans every non-main table from its first backup to its last. */
export function backupTableGroups<T extends RangeTable>(
  main: readonly RangeTable[],
  backup: readonly RangeTable[],
  all: readonly T[],
): T[][] {
  const mainIds = new Set(main.map((table) => table.id));
  const backupIds = new Set(backup.map((table) => table.id));
  const groups: T[][] = [];
  let run: T[] = [];
  const flush = () => {
    const first = run.findIndex((table) => backupIds.has(table.id));
    const last = run.findLastIndex((table) => backupIds.has(table.id));
    if (first >= 0) groups.push(run.slice(first, last + 1));
    run = [];
  };
  for (const table of [...all].sort(byLabel)) {
    if (mainIds.has(table.id)) flush();
    else run.push(table);
  }
  flush();
  return groups;
}

const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Zone names in table-number order: "2-5", "7-12", "11-12", "14-18". */
export function sortZoneNames(names: readonly string[]): string[] {
  return [...names].sort(byNumber);
}

/** The zone holding the highest-numbered active table, or null when there is none. */
export function zoneOfHighestTable(
  tables: readonly { name?: string; number?: string; floor?: string | null; is_active?: unknown }[],
): string | null {
  let top: { label: string; floor: string } | null = null;
  for (const table of tables) {
    const label = (table.name ?? table.number ?? '').trim();
    if (!label || table.is_active === false || table.is_active === 0) continue;
    if (!top || byNumber(label, top.label) > 0) top = { label, floor: table.floor?.trim() ?? '' };
  }
  return top ? top.floor : null;
}
