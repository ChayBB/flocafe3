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
