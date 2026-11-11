import type { KdsOrder } from '@/hooks/useKdsConnection';
import { kdsItemLine, spokenItemName } from '@/lib/item-options-note';
import { parseVariantSelection } from '@/lib/printer/item-heading';

export type KdsMessageKind =
  | 'move'
  | 'merge'
  | 'takeaway'
  | 'cancelled'
  | 'emergency'
  | 'kot_unprinted';

/** A notice in the KDS message bar, kept until someone acknowledges it. */
export interface KdsMessage {
  id: string;
  kind: KdsMessageKind;
  text: string;
  /** What is read aloud when it differs from the text, e.g. without an order number. */
  speech?: string;
  /** The missing kitchen ticket behind a `kot_unprinted` notice. */
  ref?: string;
  /** Why that ticket did not print. */
  reason?: string;
  /** Its printer can print again (paper loaded, back online). */
  ready?: boolean;
  at: string;
}

/** Where a menu item sits on the board: its order, that order's table or number, and any service change. */
export interface KdsItemPlace {
  orderId: number;
  place: string;
  change: string | null;
  /** The dish as the board shows it, with the chosen option ("ข้าวผัดหมู"). */
  name: string;
  /** The dish as it is read aloud. */
  spoken: string;
}

export type KdsBoardChange =
  | { kind: 'move'; key: string; from: string; to: string }
  | { kind: 'merge'; key: string; from: string; to: string }
  | { kind: 'takeaway' | 'cancelled'; key: string; place: string; item: string; spoken: string };

export function kdsItemPlaces(
  orders: KdsOrder[],
  placeOf: (order: KdsOrder) => string,
): Map<number, KdsItemPlace> {
  const places = new Map<number, KdsItemPlace>();
  for (const order of orders) {
    const place = placeOf(order);
    for (const item of order.items || []) {
      places.set(item.id, {
        orderId: order.id,
        place,
        change: item.service_change ?? null,
        name: kdsItemLine(item).name,
        spoken: spokenItemName(
          item.product_name,
          parseVariantSelection(item.variant_selection)?.name,
          item.addons,
        ),
      });
    }
  }
  return places;
}

/**
 * Compares two board snapshots item by item: an order that changed table was moved, items that
 * joined another table's order were merged into it, and an item newly packed to go turned take-away
 * (or was cancelled).
 */
export function detectKdsBoardChanges(
  before: Map<number, KdsItemPlace>,
  after: Map<number, KdsItemPlace>,
): KdsBoardChange[] {
  const changes = new Map<string, KdsBoardChange>();
  for (const [itemId, now] of after) {
    const was = before.get(itemId);
    if (!was) continue;
    if (was.orderId === now.orderId && was.place !== now.place) {
      const key = `move:${now.orderId}:${now.place}`;
      changes.set(key, { kind: 'move', key, from: was.place, to: now.place });
    } else if (was.orderId !== now.orderId && was.place !== now.place) {
      const key = `merge:${was.place}:${now.place}`;
      changes.set(key, { kind: 'merge', key, from: was.place, to: now.place });
    }
    if (now.change === 'takeaway' && was.change !== 'takeaway') {
      const key = `takeaway:${itemId}`;
      changes.set(key, {
        kind: 'takeaway',
        key,
        place: now.place,
        item: now.name,
        spoken: now.spoken,
      });
    }
    if (now.change === 'cancelled' && was.change !== 'cancelled') {
      const key = `cancelled:${itemId}`;
      changes.set(key, {
        kind: 'cancelled',
        key,
        place: now.place,
        item: now.name,
        spoken: now.spoken,
      });
    }
  }
  return [...changes.values()];
}

const MESSAGES_KEY = 'flocafe:kds-messages';
const SEEN_ALERTS_KEY = 'flocafe:kds-seen-alerts';
const MESSAGE_LIMIT = 30;
const SEEN_ALERT_LIMIT = 50;

function readList<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: unknown[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

// Messages this display has not acknowledged yet, kept across reloads.
let messages: KdsMessage[] | null = null;
const listeners = new Set<() => void>();
const NO_MESSAGES: KdsMessage[] = [];

export function getKdsMessages(): KdsMessage[] {
  messages ??= readList<KdsMessage>(MESSAGES_KEY).filter(
    (message) => message && typeof message.id === 'string' && typeof message.text === 'string',
  );
  return messages;
}

export function getServerKdsMessages(): KdsMessage[] {
  return NO_MESSAGES;
}

export function subscribeKdsMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setKdsMessages(next: KdsMessage[]): void {
  messages = next.slice(-MESSAGE_LIMIT);
  writeList(MESSAGES_KEY, messages);
  listeners.forEach((listener) => listener());
}

export function addKdsMessages(fresh: KdsMessage[]): void {
  if (fresh.length > 0) setKdsMessages([...getKdsMessages(), ...fresh]);
}

/** Turns an item's take-away notice into a cancelled one in place; returns the notices it changed. */
export function cancelKdsTakeawayMessages(cancelled: KdsMessage[]): KdsMessage[] {
  const changed: KdsMessage[] = [];
  const next = getKdsMessages().map((message) => {
    const replacement = cancelled.find((notice) =>
      message.id.startsWith(`takeaway:${notice.id.split(':')[1]}:`),
    );
    if (!replacement) return message;
    changed.push(replacement);
    return replacement;
  });
  if (changed.length > 0) setKdsMessages(next);
  return changed;
}

/**
 * Marks the notice for a missing ticket as ready to print again, adding it back if this display
 * no longer has it, and asks the message bar to open its reprint choice.
 */
export function markKdsKotReady(ref: string, fallback: KdsMessage, nonce: string): KdsMessage {
  const current = getKdsMessages();
  const existing = current.find(
    (message) => message.kind === 'kot_unprinted' && message.ref === ref,
  );
  const ready = existing ? { ...existing, ready: true } : { ...fallback, ref, ready: true };
  kotPrompt = { id: ready.id, nonce };
  setKdsMessages(
    existing
      ? current.map((message) => (message === existing ? ready : message))
      : [...current, ready],
  );
  return ready;
}

// The kept ticket whose reprint choice should open next; a new nonce opens it again.
let kotPrompt: { id: string; nonce: string } | null = null;

export function getKdsKotPrompt(): { id: string; nonce: string } | null {
  return kotPrompt;
}

export function getServerKdsKotPrompt(): null {
  return null;
}

export function dismissKdsMessage(id: string): void {
  setKdsMessages(getKdsMessages().filter((message) => message.id !== id));
}

/** Emergency alerts this display has already shown, so an acknowledged one does not come back. */
export function readSeenKdsAlerts(): string[] {
  return readList<string>(SEEN_ALERTS_KEY).filter((id) => typeof id === 'string');
}

export function writeSeenKdsAlerts(ids: string[]): void {
  writeList(SEEN_ALERTS_KEY, ids.slice(-SEEN_ALERT_LIMIT));
}
