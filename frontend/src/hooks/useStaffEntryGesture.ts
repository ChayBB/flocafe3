'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STAFF_ENTRY_HOLD_MS,
  STAFF_ENTRY_TAP_WINDOW_MS,
  recordStaffEntryTap,
  staffEntryTapsReached,
} from '@/lib/staff-entry-gesture';

/** The finger lifts after the target page has opened; its click must not land there. */
function swallowReleaseClick() {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  const release = () => setTimeout(() => window.removeEventListener('click', swallow, true));
  window.addEventListener('pointerup', release, { capture: true, once: true });
  window.addEventListener('pointercancel', release, { capture: true, once: true });
}

/** Three taps within 1.5 s, or a 3 s press, on one element calls `onEnter`. */
export function useStaffEntryGesture(onEnter: () => void) {
  const [taps, setTaps] = useState<number[]>([]);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = useRef(onEnter);
  useEffect(() => {
    enter.current = onEnter;
  }, [onEnter]);

  const stopHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  }, []);

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      stopHold();
      setHolding(true);
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        swallowReleaseClick();
        setHolding(false);
        setTaps([]);
        enter.current();
      }, STAFF_ENTRY_HOLD_MS);
    },
    [stopHold],
  );

  const onClick = useCallback(() => {
    const next = recordStaffEntryTap(taps, Date.now());
    if (resetTimer.current) clearTimeout(resetTimer.current);
    if (staffEntryTapsReached(next)) {
      setTaps([]);
      enter.current();
      return;
    }
    setTaps(next);
    resetTimer.current = setTimeout(
      () => setTaps([]),
      STAFF_ENTRY_TAP_WINDOW_MS - (Date.now() - next[0]),
    );
  }, [taps]);

  return {
    tapCount: taps.length,
    holding,
    handlers: {
      onClick,
      onPointerDown,
      onPointerUp: stopHold,
      onPointerLeave: stopHold,
      onPointerCancel: stopHold,
      onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
    },
  };
}
