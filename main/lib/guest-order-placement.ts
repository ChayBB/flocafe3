import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  type DatabaseAdmissionReservation,
  createDatabaseMaintenanceHandoff,
  getDatabase,
  revokeDatabaseMaintenanceHandoff,
} from '../db';
import { getJWTSecret } from '../security/jwt-secret';
import { getServerPort } from '../server-state';
import { getHttpRequestSignal, trackHttpRequestWork } from '../shutdown';
import { GUEST_USER_ID } from './guest-order';

/** Calls the main API on behalf of the Guest account that table-QR visitors order as. */
export async function callMainApiAsGuest(
  req: Request | undefined,
  method: 'GET' | 'POST',
  apiPath: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; data: any }> {
  const target = new URL(`/api${apiPath}`, `http://127.0.0.1:${getServerPort()}`);
  for (const [key, value] of Object.entries(options.query ?? {}))
    target.searchParams.set(key, value);
  const reservation = (
    req as (Request & { databaseAdmissionReservation?: DatabaseAdmissionReservation }) | undefined
  )?.databaseAdmissionReservation as DatabaseAdmissionReservation | undefined;
  const handoffToken = reservation ? createDatabaseMaintenanceHandoff(reservation) : undefined;
  const guestToken = jwt.sign(
    { userId: GUEST_USER_ID, email: null, role: 'server', jti: randomUUID() },
    getJWTSecret(),
    { expiresIn: '2m' },
  );
  try {
    const upstream = await fetch(target, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
        ...(options.headers ?? {}),
        ...(handoffToken ? { 'x-flo-maintenance-handoff': handoffToken } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      signal: options.signal ?? (req && getHttpRequestSignal(req)),
    });
    const text = await upstream.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: upstream.status, data };
  } finally {
    if (handoffToken) revokeDatabaseMaintenanceHandoff(handoffToken);
  }
}

const guestOrderQueues = new Map<string, Promise<unknown>>();

/** Guest orders for one table run one at a time, so two phones ordering at once never open two bills. */
export function oneGuestOrderAtATime<T>(tableId: string, work: () => Promise<T>): Promise<T> {
  const previous = guestOrderQueues.get(tableId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.catch(() => undefined);
  guestOrderQueues.set(tableId, settled);
  void settled.then(() => {
    if (guestOrderQueues.get(tableId) === settled) guestOrderQueues.delete(tableId);
  });
  return run;
}

/** The Guest account exists only for audit attribution: it has no usable password and no staff code. */
export function ensureGuestUser(): void {
  const db = getDatabase();
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(GUEST_USER_ID)) return;
  const bcrypt = require('bcryptjs');
  const unusablePassword = bcrypt.hashSync(randomUUID() + randomUUID(), 10);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, 'Guest', NULL, ?, 'server', 1, ?, ?)`,
  ).run(GUEST_USER_ID, unusablePassword, stamp, stamp);
}

export interface GuestOrderInput {
  tableId: string;
  items: unknown[];
  note: string | null;
  /** The page's key, already checked; one key is one order, however often it is sent. */
  key: string;
  source?: 'cloud';
  signal?: AbortSignal;
}

export type GuestOrderOutcome =
  | { kind: 'placed'; status: number; orderNumber: string | null; replayed: boolean }
  | { kind: 'held'; status: number; body: Record<string, unknown> }
  | { kind: 'failed'; status: number; error: string };

/**
 * Places a table-QR order as the Guest account: a retry answers from the stored result, then
 * `gate` may hold the order back (a cooldown, a quota) before it reaches the bill and the kitchen.
 */
export async function placeGuestOrder(
  req: Request | undefined,
  input: GuestOrderInput,
  gate?: () => { status: number; body: Record<string, unknown> } | null,
): Promise<GuestOrderOutcome> {
  const db = getDatabase();
  const headers = {
    'Idempotency-Key':
      input.source === 'cloud' ? `cloud-qr-${input.key}` : `guest-${input.tableId}-${input.key}`,
  };
  ensureGuestUser();
  const step = await oneGuestOrderAtATime(input.tableId, async () => {
    // A retry whose first try went through answers from the stored result: the bill it opened
    // would now send the retry down the add-items route, where the same key reads as a new request.
    const stored = db
      .prepare(
        'SELECT response_json FROM order_idempotency WHERE user_id = ? AND idempotency_key = ?',
      )
      .get(GUEST_USER_ID, headers['Idempotency-Key']) as { response_json: string } | undefined;
    if (stored) {
      return {
        result: { status: 201, data: JSON.parse(stored.response_json) },
        existingItemIds: new Set<number>(),
        replayed: true,
      };
    }
    const held = gate?.();
    if (held) return { held };
    const open = db
      .prepare(
        `SELECT id FROM orders WHERE table_id = ? AND type = 'dine_in'
         AND status IN ('pending', 'preparing', 'ready') ORDER BY id DESC LIMIT 1`,
      )
      .get(input.tableId) as { id: number } | undefined;
    const existingItemIds = new Set(
      open
        ? (
            db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(open.id) as {
              id: number;
            }[]
          ).map((row) => row.id)
        : [],
    );
    const placement = open
      ? callMainApiAsGuest(req, 'POST', `/orders/${open.id}/items`, {
          body: { items: input.items, special_instructions: input.note ?? undefined },
          headers,
          signal: input.signal,
        })
      : callMainApiAsGuest(req, 'POST', '/orders', {
          body: {
            table_id: input.tableId,
            type: 'dine_in',
            special_instructions: input.note ?? undefined,
            items: input.items,
          },
          headers,
          signal: input.signal,
        });
    const result = await (req ? trackHttpRequestWork(req, placement) : placement);
    return { result, existingItemIds, replayed: false };
  });
  if (step.held) return { kind: 'held', status: step.held.status, body: step.held.body };
  const { result, existingItemIds, replayed } = step;
  if (result.status >= 400 || !result.data?.order) {
    return {
      kind: 'failed',
      status: result.status >= 400 ? result.status : 502,
      error: result.data?.error || 'Could not send the order',
    };
  }
  const order = result.data.order;
  if (!replayed) {
    const newItems = (order.items || []).filter(
      (item: { id: number }) => !existingItemIds.has(item.id),
    );
    // The kitchen ticket is printed here because a guest has no print permission of their own.
    void callMainApiAsGuest(req, 'POST', '/printers/print-kot', {
      body: { orderId: order.id, items: newItems },
    }).catch(() => undefined);
  }
  return { kind: 'placed', status: 201, orderNumber: order.order_number ?? null, replayed };
}
