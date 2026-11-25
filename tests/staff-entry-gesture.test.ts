/** Hidden staff entry on the service menu: three taps inside 1.5 s count, slower taps restart. */
import assert from 'node:assert/strict';
import {
  STAFF_ENTRY_HOLD_MS,
  recordStaffEntryTap,
  staffEntryTapsReached,
} from '../frontend/src/lib/staff-entry-gesture';

const tapAll = (times: number[]) =>
  times.reduce<number[]>((taps, at) => recordStaffEntryTap(taps, at), []);

assert.equal(staffEntryTapsReached(tapAll([0, 400, 900])), true, 'three quick taps enter');
assert.equal(
  staffEntryTapsReached(tapAll([0, 700, 1500])),
  true,
  'third tap exactly at 1.5 s enters',
);
assert.equal(
  staffEntryTapsReached(tapAll([0, 800, 1501])),
  false,
  'third tap after 1.5 s does not enter',
);
assert.deepEqual(tapAll([0, 800, 1600]), [800, 1600], 'expired taps drop out of the window');
assert.equal(
  staffEntryTapsReached(tapAll([0, 800, 1600, 2000])),
  true,
  'a new run of taps can still enter',
);
assert.equal(staffEntryTapsReached(tapAll([0, 500])), false, 'two taps are not enough');
assert.equal(STAFF_ENTRY_HOLD_MS, 3000);

console.log('staff-entry-gesture: ok');
