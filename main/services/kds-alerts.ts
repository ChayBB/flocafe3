import { randomUUID } from 'crypto';

/**
 * A message every kitchen display shows: an emergency call from the Server App, a kitchen ticket
 * the printer did not print, or word that its printer can print that ticket again.
 */
export interface KdsAlert {
  id: string;
  kind: 'emergency' | 'kot_unprinted' | 'kot_ready';
  message: string;
  table: string | null;
  sent_by: string | null;
  /** The missing kitchen ticket this alert is about, so a display can reprint or drop it. */
  ref?: string | null;
  /** Why the ticket did not print (`paper_out`, `offline`, ...). */
  reason?: string | null;
  created_at: string;
}

export const KDS_ALERT_MESSAGE_MAX = 120;
const KDS_ALERT_TTL_MS = 30 * 60 * 1000;
const KDS_ALERT_LIMIT = 20;

// Kept in memory only: a display that reconnects within the window still sees recent alerts.
let alerts: KdsAlert[] = [];

export function addKdsAlert(input: {
  message?: string;
  table?: string | null;
  sentBy?: string | null;
  kind?: KdsAlert['kind'];
  ref?: string | null;
  reason?: string | null;
}): KdsAlert {
  const alert: KdsAlert = {
    id: randomUUID(),
    kind: input.kind ?? 'emergency',
    message: String(input.message ?? '')
      .trim()
      .slice(0, KDS_ALERT_MESSAGE_MAX),
    table: input.table ? String(input.table).trim().slice(0, 40) || null : null,
    sent_by: input.sentBy ?? null,
    ref: input.ref ?? null,
    ...(input.reason ? { reason: input.reason } : {}),
    created_at: new Date().toISOString(),
  };
  alerts = [...recentKdsAlerts(), alert].slice(-KDS_ALERT_LIMIT);
  return alert;
}

export function recentKdsAlerts(nowMs = Date.now()): KdsAlert[] {
  alerts = alerts.filter((alert) => nowMs - Date.parse(alert.created_at) < KDS_ALERT_TTL_MS);
  return alerts;
}

export function clearKdsAlertsForTest(): void {
  alerts = [];
}
