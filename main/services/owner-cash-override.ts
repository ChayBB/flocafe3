/**
 * Owner override for cash blocked by the shift gate: the owner's PIN, checked
 * here on every action, lets one cash payment or one drawer pulse through.
 */
import {
  getDatabase,
  localDateInTimezone,
  recordAuthAudit,
  recordOrderAudit,
  tenantBusinessDayStartTime,
  verifyPinAsync,
} from '../db';
import { clockNow } from '../lib/clock';
import {
  checkPinRateLimit,
  clearPinRateLimit,
  isPinRateLimited,
  normalizeIpForRateLimit,
  withPinVerificationLock,
} from '../middleware/security';
import {
  MAX_MOVEMENT_REASON_LENGTH,
  insertCashDrawerMovement,
  tenantTimezone,
} from './cash-drawer-movements';
import { NO_CASH_SESSION_ID } from './shift-session-gate';

type Db = ReturnType<typeof getDatabase>;

export const OWNER_OVERRIDE_REASON_MAX = 200;
export const OWNER_CASH_OVERRIDE_EVENT = 'owner_cash_override';
/** Gate refusals an owner may override. */
export const OVERRIDABLE_CASH_BLOCKS = new Set(['cash_session_required', 'day_already_closed']);

/** Request fields that carry the override; never stored on a payment line. */
export const OWNER_OVERRIDE_FIELDS = [
  'owner_override_pin',
  'owner_override_approver_id',
  'owner_override_reason',
] as const;

export interface OwnerCashOverrideRequest {
  pin: unknown;
  approverId: unknown;
  reason: unknown;
}

export interface VerifiedOwnerCashOverride {
  ownerId: string;
  ownerName: string;
  reason: string;
}

function overrideError(message: string, statusCode: number, diagnosticCode: string): Error {
  return Object.assign(new Error(message), { statusCode, diagnosticCode });
}

/** Reads override fields from a request body; null when no override was asked for. */
export function readOwnerCashOverride(body: unknown): OwnerCashOverrideRequest | null {
  const source = (body ?? {}) as Record<string, unknown>;
  if (source.owner_override_pin === undefined || source.owner_override_pin === null) return null;
  return {
    pin: source.owner_override_pin,
    approverId: source.owner_override_approver_id,
    reason: source.owner_override_reason,
  };
}

export async function verifyOwnerCashOverride(
  db: Db,
  request: OwnerCashOverrideRequest,
  context: { clientIp: string; actorUserId: string; action: 'payment' | 'drawer_kick' },
): Promise<VerifiedOwnerCashOverride> {
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (reason.length < 3 || reason.length > OWNER_OVERRIDE_REASON_MAX) {
    throw overrideError(
      `A reason of 3-${OWNER_OVERRIDE_REASON_MAX} characters is required`,
      400,
      'owner_override_reason_required',
    );
  }
  const rateLimitKey = `pin:${normalizeIpForRateLimit(context.clientIp)}:owner-cash-override`;
  const audit = (outcome: 'failure' | 'rate_limited', userId: string | null) =>
    recordAuthAudit(db, {
      userId,
      eventType: OWNER_CASH_OVERRIDE_EVENT,
      outcome,
      ipAddress: context.clientIp,
      details: { action: context.action, actor_user_id: context.actorUserId, reason },
    });
  const rateLimited = () => {
    audit('rate_limited', null);
    return overrideError(
      'Too many PIN attempts. Try again in 15 minutes.',
      429,
      'pin_rate_limited',
    );
  };
  const invalid = () => {
    checkPinRateLimit(rateLimitKey);
    audit('failure', null);
    return overrideError('Invalid owner PIN', 403, 'owner_pin_invalid');
  };
  if (isPinRateLimited(rateLimitKey)) throw rateLimited();
  if (typeof request.pin !== 'string' || !/^\d{4,6}$/.test(request.pin)) throw invalid();
  const pin = request.pin;
  const approverId =
    typeof request.approverId === 'string' && request.approverId.trim()
      ? request.approverId.trim()
      : null;

  return withPinVerificationLock(rateLimitKey, async () => {
    if (isPinRateLimited(rateLimitKey)) throw rateLimited();
    const owners = db
      .prepare(
        `SELECT id, name, pin_hash FROM users
          WHERE role = 'owner' AND is_active = 1 AND pin_hash IS NOT NULL
            AND (? IS NULL OR id = ?)`,
      )
      .all(approverId, approverId) as { id: string; name: string; pin_hash: string }[];
    for (const owner of owners) {
      if (await verifyPinAsync(owner.pin_hash, pin)) {
        clearPinRateLimit(rateLimitKey);
        return { ownerId: owner.id, ownerName: owner.name, reason };
      }
    }
    throw invalid();
  });
}

function nextIsoDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Records a used override. Cash taken after the day closed stays on its real
 * time for sales, while the closed Z is immutable, so it enters the drawer as
 * a pay-in on the next business date to keep that day's count right.
 */
export function recordOwnerCashOverrideUse(
  db: Db,
  override: VerifiedOwnerCashOverride,
  use: {
    action: 'payment' | 'drawer_kick';
    actorUserId: string;
    clientIp: string;
    blockedBy: string;
    cashCents?: number;
    bill?: { id: number | string; orderId: number | string; billNumber: string };
  },
): { payInBusinessDate: string | null } {
  let payInBusinessDate: string | null = null;
  if (use.blockedBy === 'day_already_closed' && use.bill && (use.cashCents ?? 0) > 0) {
    const today = localDateInTimezone(clockNow(), tenantTimezone(), tenantBusinessDayStartTime(db));
    payInBusinessDate = nextIsoDate(today);
    insertCashDrawerMovement(db, {
      businessDate: payInBusinessDate,
      movementType: 'pay_in',
      amountCents: use.cashCents as number,
      reason: `${use.bill.billNumber}: ${override.reason}`.slice(0, MAX_MOVEMENT_REASON_LENGTH),
      createdBy: override.ownerId,
      cashSessionId: NO_CASH_SESSION_ID,
    });
  }
  const details = {
    action: use.action,
    actor_user_id: use.actorUserId,
    owner_user_id: override.ownerId,
    owner_name: override.ownerName,
    reason: override.reason,
    blocked_by: use.blockedBy,
    ...(use.bill ? { bill_id: use.bill.id, bill_number: use.bill.billNumber } : {}),
    ...(use.cashCents !== undefined ? { cash_cents: use.cashCents } : {}),
    ...(payInBusinessDate ? { pay_in_business_date: payInBusinessDate } : {}),
  };
  if (use.bill) {
    recordOrderAudit(db, {
      orderId: use.bill.orderId,
      actorUserId: use.actorUserId,
      action: OWNER_CASH_OVERRIDE_EVENT,
      details,
    });
  }
  recordAuthAudit(db, {
    userId: override.ownerId,
    eventType: OWNER_CASH_OVERRIDE_EVENT,
    outcome: 'success',
    ipAddress: use.clientIp,
    details,
  });
  return { payInBusinessDate };
}
