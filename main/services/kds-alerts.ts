import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

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
  /** Kitchen station name a ticket alert belongs to; only displays showing that station get it. */
  station?: string | null;
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
  station?: string | null;
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
    ...(input.station ? { station: input.station } : {}),
    created_at: new Date().toISOString(),
  };
  alerts = [...recentKdsAlerts(), alert].slice(-KDS_ALERT_LIMIT);
  return alert;
}

export function recentKdsAlerts(nowMs = Date.now()): KdsAlert[] {
  alerts = alerts.filter((alert) => nowMs - Date.parse(alert.created_at) < KDS_ALERT_TTL_MS);
  return alerts;
}

/**
 * Alerts for a display scoped to the given station ids (empty = every station). A ticket alert whose
 * station is not an active station (an unrouted ticket) still reaches every display.
 */
export function kdsAlertsForStations(
  db: Database.Database,
  stationIds: readonly string[],
): KdsAlert[] {
  const recent = recentKdsAlerts();
  if (stationIds.length === 0 || !recent.some((alert) => alert.station)) return recent;
  const stations = db
    .prepare('SELECT id, name FROM kitchen_stations WHERE is_active = 1')
    .all() as {
    id: string;
    name: string;
  }[];
  const shown = new Set(stationIds.map(String));
  const allNames = new Set(stations.map((station) => station.name));
  const shownNames = new Set(
    stations.filter((station) => shown.has(String(station.id))).map((station) => station.name),
  );
  return recent.filter(
    (alert) => !alert.station || !allNames.has(alert.station) || shownNames.has(alert.station),
  );
}

export function clearKdsAlertsForTest(): void {
  alerts = [];
}
