import log from 'electron-log';
import { sanitizeLogTail } from './log-sanitizer';

const FIELD_MAX = 500;
const RATE_LIMIT_LOG_GAP_MS = 60_000;
const lastRateLimitLog = new Map<string, number>();

function clean(value: unknown): string {
  return sanitizeLogTail(String(value ?? '')).slice(0, FIELD_MAX);
}

/** Records an error the Server App hid from the person using it, so staff can find it in main.log. */
export function recordClientError(
  body: unknown,
  meta: { ip: string; userAgent: string | undefined },
): void {
  const input = (body ?? {}) as Record<string, unknown>;
  log.warn('[ServerApp client error]', {
    message: clean(input.message),
    context: clean(input.context),
    page: clean(input.page),
    audience: input.audience === 'staff' ? 'staff' : 'customer',
    ip: meta.ip,
    user_agent: clean(meta.userAgent),
  });
}

/** Logs a refused request at most once a minute per caller and route, so a burst cannot flood the log. */
export function recordRateLimited(ip: string, route: string, limit: number): void {
  const key = `${ip} ${route}`;
  const now = Date.now();
  if (now - (lastRateLimitLog.get(key) ?? 0) < RATE_LIMIT_LOG_GAP_MS) return;
  lastRateLimitLog.set(key, now);
  if (lastRateLimitLog.size > 1000) lastRateLimitLog.clear();
  log.warn('[ServerApp] rate limited', { ip, route, limit_per_minute: limit });
}
