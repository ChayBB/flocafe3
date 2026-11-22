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
