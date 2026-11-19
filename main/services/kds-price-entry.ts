import type { PendingPriceMode } from '../lib/weight-pending';

/** A KDS item update that weighs or prices a line instead of changing its stage. */
export interface KdsPriceEntry {
  mode: PendingPriceMode;
  value: unknown;
}

export function readKdsPriceEntry(body: unknown): KdsPriceEntry | undefined {
  const entry = body as { weight?: unknown; price?: unknown } | undefined;
  if (entry?.weight !== undefined) return { mode: 'weight', value: entry.weight };
  if (entry?.price !== undefined) return { mode: 'kitchen_price', value: entry.price };
  return undefined;
}
