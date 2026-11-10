import { useEffect, type RefObject } from 'react';

const DECAY_PER_MS = 0.998;
const MIN_SPEED = 0.02;
const DRAG_THRESHOLD = 8;

/**
 * Replaces the native touch fling of a vertical scroller with one whose release speed is scaled,
 * so the list coasts a shorter distance. Dragging stays 1:1 and horizontal gestures stay native.
 */
export function useDampedFlingScroll(
  ref: RefObject<HTMLElement | null>,
  scale: number | undefined,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element || scale == null || scale === 1) return;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let axis: 'x' | 'y' | null = null;
    let frame = 0;

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onStart = (event: TouchEvent) => {
      stop();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = lastY = touch.clientY;
      lastTime = event.timeStamp;
      velocity = 0;
      axis = null;
    };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!axis) {
        const dx = Math.abs(touch.clientX - startX);
        const dy = Math.abs(touch.clientY - startY);
        if (Math.max(dx, dy) < DRAG_THRESHOLD) return;
        axis = dy >= dx ? 'y' : 'x';
      }
      if (axis !== 'y') return;
      event.preventDefault();
      const delta = lastY - touch.clientY;
      const elapsed = Math.max(1, event.timeStamp - lastTime);
      element.scrollTop += delta;
      velocity = 0.8 * (delta / elapsed) + 0.2 * velocity;
      lastY = touch.clientY;
      lastTime = event.timeStamp;
    };
    const onEnd = (event: TouchEvent) => {
      if (axis !== 'y') return;
      // A finger that paused before lifting should not fling.
      let speed = event.timeStamp - lastTime > 100 ? 0 : velocity * scale;
      let previous = performance.now();
      let carry = 0;
      const step = (now: number) => {
        const elapsed = now - previous;
        previous = now;
        speed *= DECAY_PER_MS ** elapsed;
        if (Math.abs(speed) < MIN_SPEED) return stop();
        carry += speed * elapsed;
        const whole = Math.trunc(carry);
        if (whole !== 0) {
          carry -= whole;
          const before = element.scrollTop;
          element.scrollTop += whole;
          if (element.scrollTop === before) return stop();
        }
        frame = requestAnimationFrame(step);
      };
      if (Math.abs(speed) >= MIN_SPEED) frame = requestAnimationFrame(step);
    };

    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', stop, { passive: true });
    return () => {
      stop();
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', stop);
    };
  }, [ref, scale]);
}
