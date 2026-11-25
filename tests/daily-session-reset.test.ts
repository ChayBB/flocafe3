import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDailyResetEpochSeconds } from '../main/lib/daily-session-reset';

const reset = (iso: string, zone: string) =>
  new Date(nextDailyResetEpochSeconds(new Date(iso), zone) * 1000).toISOString();

test('resets at the coming 06:00 store time on the same day', () => {
  assert.equal(reset('2026-10-23T22:59:00Z', 'Asia/Bangkok'), '2026-10-23T23:00:00.000Z');
});

test('at and after 06:00 the next reset is the following day', () => {
  assert.equal(reset('2026-10-23T23:00:00Z', 'Asia/Bangkok'), '2026-10-24T23:00:00.000Z');
  assert.equal(reset('2026-10-24T10:00:00Z', 'Asia/Bangkok'), '2026-10-24T23:00:00.000Z');
});

test('uses the store time zone rather than UTC, including half-hour offsets', () => {
  assert.equal(reset('2026-10-24T00:00:00Z', 'Asia/Kolkata'), '2026-10-24T00:30:00.000Z');
  assert.equal(reset('2026-10-24T00:31:00Z', 'Asia/Kolkata'), '2026-10-25T00:30:00.000Z');
});

test('follows daylight saving changes', () => {
  assert.equal(reset('2026-03-08T05:00:00Z', 'America/New_York'), '2026-03-08T10:00:00.000Z');
  assert.equal(reset('2026-03-07T12:00:00Z', 'America/New_York'), '2026-03-08T10:00:00.000Z');
  assert.equal(reset('2026-11-01T04:00:00Z', 'America/New_York'), '2026-11-01T11:00:00.000Z');
});

test('a session never outlives 24 hours', () => {
  const now = new Date('2026-10-24T01:00:00Z');
  const seconds =
    nextDailyResetEpochSeconds(now, 'Asia/Bangkok') - Math.floor(now.getTime() / 1000);
  assert.ok(seconds > 0 && seconds <= 24 * 3600);
});

test('a staff session ends at the store business-day start, minutes included', () => {
  const at = (iso: string) =>
    new Date(nextDailyResetEpochSeconds(new Date(iso), 'Asia/Bangkok', 4, 30) * 1000).toISOString();
  assert.equal(at('2026-10-23T21:00:00Z'), '2026-10-23T21:30:00.000Z');
  assert.equal(at('2026-10-23T21:30:00Z'), '2026-10-24T21:30:00.000Z');
});
