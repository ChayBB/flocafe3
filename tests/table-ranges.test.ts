/** Typed table ranges on the staff profile: numbered runs, exact names, and ranges rebuilt from choices. */
import assert from 'node:assert/strict';
import { resolveTableRange, tablesToRanges } from '../frontend/src/lib/table-ranges';

const tables = ['9', '10', '11', '15', '16', '17', '19', 'VIP', 'Bar 1'].map((label) => ({
  id: `t-${label}`,
  label,
}));
const labels = (list: { label: string }[]) => list.map((table) => table.label);

assert.deepEqual(labels(resolveTableRange({ from: '15', to: '16' }, tables)), ['15', '16']);
assert.deepEqual(labels(resolveTableRange({ from: '17', to: '15' }, tables)), ['15', '16', '17']);
assert.deepEqual(labels(resolveTableRange({ from: '17', to: '19' }, tables)), ['17', '19']);
assert.deepEqual(labels(resolveTableRange({ from: '10', to: '' }, tables)), ['10']);
assert.deepEqual(labels(resolveTableRange({ from: 'VIP', to: 'VIP' }, tables)), ['VIP']);
assert.deepEqual(labels(resolveTableRange({ from: 'VIP', to: '15' }, tables)), []);
assert.deepEqual(labels(resolveTableRange({ from: '30', to: '40' }, tables)), []);
assert.deepEqual(labels(resolveTableRange({ from: ' ', to: '' }, tables)), []);

const pick = (...names: string[]) => tables.filter((table) => names.includes(table.label));
assert.deepEqual(tablesToRanges(pick('15', '16'), tables), [{ from: '15', to: '16' }]);
assert.deepEqual(tablesToRanges(pick('9', '10', '11', '17', '19'), tables), [
  { from: '9', to: '11' },
  { from: '17', to: '19' },
]);
assert.deepEqual(tablesToRanges(pick('15', '17'), tables), [
  { from: '15', to: '15' },
  { from: '17', to: '17' },
]);
assert.deepEqual(tablesToRanges(pick('VIP', '19'), tables), [
  { from: '19', to: '19' },
  { from: 'VIP', to: 'VIP' },
]);
assert.deepEqual(tablesToRanges([], tables), []);

console.log('table-ranges: ok');
