import { useEffect } from 'react';

/** Text size in whole percent of the app's normal size, changed in steps. */
export const FONT_SCALE_MIN = 80;
export const FONT_SCALE_MAX = 200;
export const FONT_SCALE_STEP = 10;

export function clampFontScale(scale: number): number {
  const stepped = Math.round(scale / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, stepped));
}

/** The stored scale for this device, or null when it never chose one. */
export function readStoredFontScale(key: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clampFontScale(stored) : null;
  } catch {
    return null;
  }
}

export function storeFontScale(key: string, scale: number): void {
  try {
    window.localStorage.setItem(key, String(scale));
  } catch {}
}

/** The UI is sized in rem, so scaling the root font grows text and layout together. */
export function useRootFontScale(scale: number, enabled = true): void {
  useEffect(() => {
    if (!enabled || scale === 100) return;
    const html = document.documentElement;
    const previous = html.style.fontSize;
    html.style.fontSize = `${scale}%`;
    return () => {
      html.style.fontSize = previous;
    };
  }, [scale, enabled]);
}
