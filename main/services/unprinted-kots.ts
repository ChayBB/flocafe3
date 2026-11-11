import { addKdsAlert } from './kds-alerts';
import { notifyKdsUpdate } from './kds';
import { probeNetworkPrinter, type PrinterProbeResult } from '../printers/network-status';

/** Why a kitchen ticket did not print, so staff know what to fix before printing it again. */
export type UnprintedKotReason = 'paper_out' | 'needs_attention' | 'offline' | 'timeout' | 'error';

/** A kitchen ticket that did not print, kept until it prints or staff dismiss it. */
export interface UnprintedKot {
  id: string;
  order_id: number;
  order_number: string;
  table: string | null;
  station: string;
  detail: string | null;
  reason: UnprintedKotReason;
  /** Only these items are printed again, so items that already printed never print twice. */
  item_ids: number[];
  /** The network printer it failed on, watched until it can print again. */
  printer: { ip: string; port: number } | null;
  /** The printer answered again (paper loaded, back online) and the ticket waits for a reprint. */
  ready: boolean;
  created_at: string;
}

const UNPRINTED_KOT_TTL_MS = 6 * 60 * 60 * 1000;
export const PRINTER_WATCH_INTERVAL_MS = 5000;

// Kept in memory only, like kitchen display alerts; a restart starts with an empty list.
let unprinted: UnprintedKot[] = [];

const keyOf = (orderId: number, station: string) => `${orderId}:${station}`;

export function unprintedKotReason(
  detail: string | null | undefined,
  failureClass: string | null | undefined,
): UnprintedKotReason {
  if (/out of paper|paper[- ]?out/i.test(String(detail ?? ''))) return 'paper_out';
  if (failureClass === 'needs_attention') return 'needs_attention';
  if (failureClass === 'offline' || /^Network error:/i.test(String(detail ?? ''))) return 'offline';
  if (failureClass === 'timeout') return 'timeout';
  return 'error';
}

/**
 * Records a failed kitchen ticket and tells every kitchen display it is missing. Another failure for
 * the same order and station adds its items to the same entry instead of a second warning.
 */
export function recordUnprintedKot(input: {
  orderId: number;
  orderNumber: string;
  table?: string | null;
  station: string;
  detail?: string | null;
  failureClass?: string | null;
  itemIds?: number[];
  printer?: { ip: string; port: number } | null;
}): UnprintedKot {
  const id = keyOf(input.orderId, input.station);
  const reason = unprintedKotReason(input.detail, input.failureClass);
  const existing = listUnprintedKots().find((entry) => entry.id === id);
  if (existing) {
    existing.item_ids = [...new Set([...existing.item_ids, ...(input.itemIds ?? [])])];
    existing.detail = input.detail ?? existing.detail;
    existing.reason = reason;
    existing.printer = input.printer ?? existing.printer;
    existing.ready = false;
    watchPrinters();
    return existing;
  }
  const entry: UnprintedKot = {
    id,
    order_id: input.orderId,
    order_number: input.orderNumber,
    table: input.table ?? null,
    station: input.station,
    detail: input.detail ?? null,
    reason,
    item_ids: [...new Set(input.itemIds ?? [])],
    printer: input.printer ?? null,
    ready: false,
    created_at: new Date().toISOString(),
  };
  unprinted = [...unprinted, entry];
  addKdsAlert({
    kind: 'kot_unprinted',
    message: input.orderNumber,
    table: input.table ?? null,
    ref: id,
    reason,
  });
  notifyKdsUpdate();
  watchPrinters();
  return entry;
}

/**
 * Clears what printed from an order's warning for that station. Without item ids the whole warning
 * goes; with them, items still missing keep the warning open.
 */
export function clearUnprintedKot(orderId: number, station: string, printedItemIds?: number[]) {
  const id = keyOf(orderId, station);
  const entry = unprinted.find((item) => item.id === id);
  if (!entry) return;
  if (printedItemIds && entry.item_ids.length > 0) {
    const printed = new Set(printedItemIds);
    entry.item_ids = entry.item_ids.filter((itemId) => !printed.has(itemId));
    if (entry.item_ids.length > 0) return;
  }
  unprinted = unprinted.filter((item) => item.id !== id);
}

export function findUnprintedKot(orderId: number, station: string): UnprintedKot | undefined {
  return listUnprintedKots().find((entry) => entry.id === keyOf(orderId, station));
}

export function dismissUnprintedKot(id: string): boolean {
  const before = unprinted.length;
  unprinted = unprinted.filter((entry) => entry.id !== id);
  return unprinted.length !== before;
}

export function listUnprintedKots(nowMs = Date.now()): UnprintedKot[] {
  unprinted = unprinted.filter(
    (entry) => nowMs - Date.parse(entry.created_at) < UNPRINTED_KOT_TTL_MS,
  );
  return unprinted;
}

type PrinterProbe = (ip: string, port: number) => Promise<PrinterProbeResult>;
let probe: PrinterProbe = (ip, port) => probeNetworkPrinter(ip, port);
let watchTimer: NodeJS.Timeout | null = null;
let watching = false;

function isPrinterBack(entry: UnprintedKot, result: PrinterProbeResult): boolean {
  if (result === 'ok' || result === 'near_end') return true;
  // A printer that never reported paper status is back once it takes connections again.
  return (
    result === 'no_answer' && entry.reason !== 'paper_out' && entry.reason !== 'needs_attention'
  );
}

/**
 * Checks each waiting ticket's printer once. When it can print again the ticket is marked ready and
 * the kitchen displays offer to print it; nothing prints without a person choosing to.
 */
export async function checkUnprintedKotPrinters(): Promise<void> {
  if (watching) return;
  watching = true;
  try {
    const waiting = listUnprintedKots().filter((entry) => entry.printer && !entry.ready);
    const results = new Map<string, Promise<PrinterProbeResult>>();
    for (const entry of waiting) {
      const { ip, port } = entry.printer!;
      const key = `${ip}:${port}`;
      if (!results.has(key))
        results.set(
          key,
          probe(ip, port).catch(() => 'unreachable' as const),
        );
      const result = await results.get(key)!;
      if (!unprinted.includes(entry) || entry.ready || !isPrinterBack(entry, result)) continue;
      entry.ready = true;
      addKdsAlert({
        kind: 'kot_ready',
        message: entry.order_number,
        table: entry.table,
        ref: entry.id,
        reason: entry.reason,
      });
      notifyKdsUpdate();
    }
  } finally {
    watching = false;
    if (!unprinted.some((entry) => entry.printer && !entry.ready)) stopWatching();
  }
}

function watchPrinters(): void {
  if (watchTimer || !unprinted.some((entry) => entry.printer && !entry.ready)) return;
  watchTimer = setInterval(() => void checkUnprintedKotPrinters(), PRINTER_WATCH_INTERVAL_MS);
  watchTimer.unref?.();
}

function stopWatching(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

export function setPrinterProbeForTest(next: PrinterProbe | null): void {
  probe = next ?? ((ip, port) => probeNetworkPrinter(ip, port));
}

export function clearUnprintedKotsForTest(): void {
  unprinted = [];
  stopWatching();
}
