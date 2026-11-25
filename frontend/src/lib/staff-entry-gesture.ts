export const STAFF_ENTRY_TAPS = 3;
export const STAFF_ENTRY_TAP_WINDOW_MS = 1500;
export const STAFF_ENTRY_HOLD_MS = 3000;

/** Tap times still inside the window that ends at `now`, with `now` appended. */
export function recordStaffEntryTap(taps: readonly number[], now: number): number[] {
  return [...taps.filter((at) => now - at <= STAFF_ENTRY_TAP_WINDOW_MS), now];
}

export function staffEntryTapsReached(taps: readonly number[]): boolean {
  return taps.length >= STAFF_ENTRY_TAPS;
}
