import { getSettingValue, upsertSettings } from '../../db';
import {
  QrCloudConfigError,
  QR_CLOUD_SETTING_KEYS,
  readConfig,
  clearConnectorToken,
  readConnectorSetting,
  updateConfig,
  writeConnectorToken,
  type QrCloudConfig,
  type QrCloudConfigPatch,
} from './config';
import {
  QrCloudClientError,
  fetchConnectorEvents as defaultFetchConnectorEvents,
  type CloudEventsResponse,
  type FetchEventsOptions,
} from './client';
import {
  inboxSummary,
  recentPolls,
  recordPoll,
  storeEvents,
  clearErrorHistory as clearInboxErrors,
  closeInbox,
  type InboxSummary,
} from './inbox';
import { caStatus, readApprovedCa } from './tls';

/**
 * Connection lifecycle for the integrated Cloud connector.
 *
 * Exactly one polling loop exists per process: `start()` cancels the previous generation before
 * beginning a new one, and every scheduled step checks its generation. Bounded timeouts and
 * exponential backoff with jitter apply to every attempt; shutdown cancels an in-flight request.
 *
 * The connector is inbox-only by product decision: a successful poll stores events and updates
 * status. It never creates POS orders, sends an ACK or changes Cloud state.
 */

export type QrCloudState =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'CONNECTING'
  | 'CONNECTED_POLLING'
  | 'CONNECTED_WEBSOCKET'
  | 'DEGRADED'
  | 'AUTH_FAILED'
  | 'TLS_FAILED'
  | 'OFFLINE'
  | 'STOPPING';

export interface ConnectorErrorEntry {
  at: string;
  code: string;
  detail: string | null;
}

const ERROR_HISTORY_LIMIT = 20;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 120_000;

let state: QrCloudState = 'DISABLED';
let generation = 0;
let loopTimer: NodeJS.Timeout | null = null;
let inFlight: AbortController | null = null;
let failures = 0;
let lastSuccessAt: string | null = null;
let lastError: ConnectorErrorEntry | null = null;
let errorHistory: ConnectorErrorEntry[] = [];
let lastPollAt: string | null = null;
let lastEventCount = 0;
let startedAt: string | null = null;
let applyRevision = 0;

/** Test seam: the poll loop's transport can be replaced, production always uses the HTTPS client. */
let fetchEventsImpl: (options: FetchEventsOptions) => Promise<CloudEventsResponse> =
  defaultFetchConnectorEvents;

export function __setFetchEventsForTests(
  impl: ((options: FetchEventsOptions) => Promise<CloudEventsResponse>) | null,
): void {
  fetchEventsImpl = impl ?? defaultFetchConnectorEvents;
}

function nowIso(): string {
  return new Date().toISOString();
}

function recordError(code: string, detail?: string | null): void {
  const entry: ConnectorErrorEntry = {
    at: nowIso(),
    code,
    detail: detail ? String(detail).slice(0, 160) : null,
  };
  lastError = entry;
  errorHistory = [...errorHistory, entry].slice(-ERROR_HISTORY_LIMIT);
  try {
    upsertSettings({
      [QR_CLOUD_SETTING_KEYS.lastError]: entry.code,
      [QR_CLOUD_SETTING_KEYS.lastErrorAt]: entry.at,
    });
  } catch {
    // Status reporting must not fail the loop.
  }
}

function stateForError(error: unknown): QrCloudState {
  const code =
    error instanceof QrCloudClientError || error instanceof QrCloudConfigError
      ? error.code
      : 'offline';
  if (code === 'auth_failed') return 'AUTH_FAILED';
  if (code === 'tls_failed') return 'TLS_FAILED';
  if (code === 'offline' || code === 'timeout' || code === 'blocked_target') return 'OFFLINE';
  return 'DEGRADED';
}

function backoffDelay(attempt: number, config: QrCloudConfig): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempt - 1, 0), BACKOFF_CAP_MS);
  const jitter = Math.floor(Math.random() * Math.max(250, exponential * 0.2));
  return Math.min(exponential + jitter, Math.max(BACKOFF_CAP_MS, config.pollIntervalMs));
}

function clearTimer(): void {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
}

function cancelInFlight(): void {
  if (inFlight) {
    try {
      inFlight.abort();
    } catch {
      // Aborting a finished request is a no-op.
    }
  }
  inFlight = null;
}

function schedule(generationAtSchedule: number, delayMs: number): void {
  clearTimer();
  loopTimer = setTimeout(() => {
    loopTimer = null;
    if (generation !== generationAtSchedule || state === 'STOPPING') return;
    void pollOnce(generationAtSchedule);
  }, delayMs);
}

async function pollOnce(generationAtPoll: number): Promise<void> {
  const config = readConfig();
  if (generation !== generationAtPoll) return;
  if (!config.enabled) {
    state = 'DISABLED';
    return;
  }
  if (!config.cloudUrl || !readConnectorSetting()) {
    state = 'NOT_CONFIGURED';
    return;
  }
  if (state === 'DISABLED' || state === 'NOT_CONFIGURED' || state === 'CONNECTED_POLLING') {
    state = 'CONNECTING';
  }
  const controller = new AbortController();
  inFlight = controller;
  try {
    const ca = readApprovedCa();
    const response = await fetchEventsImpl({
      config,
      token: readConnectorSetting(),
      caPem: ca?.pem ?? null,
      signal: controller.signal,
    });
    if (generation !== generationAtPoll) return;
    const result = storeEvents(response.events);
    lastPollAt = nowIso();
    lastEventCount = response.events.length;
    recordPoll(response.events.length, 'ok');
    lastSuccessAt = lastPollAt;
    failures = 0;
    lastError = null;
    state = 'CONNECTED_POLLING';
    upsertSettings({ [QR_CLOUD_SETTING_KEYS.lastSuccessAt]: lastSuccessAt });
    if (result.rejected > 0) recordError('event_rejected', `${result.rejected} event(s) rejected`);
    schedule(generationAtPoll, config.pollIntervalMs);
  } catch (error) {
    if (generation !== generationAtPoll) return;
    const code = error instanceof QrCloudClientError ? error.code : 'offline';
    const detail = error instanceof QrCloudClientError ? error.detail : null;
    failures += 1;
    recordPoll(0, 'error', code);
    recordError(code, detail ?? null);
    state = failures >= config.retryMax ? 'DEGRADED' : stateForError(error);
    const delay =
      failures >= config.retryMax ? config.reconcileIntervalMs : backoffDelay(failures, config);
    schedule(generationAtPoll, delay);
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

function stopLoop(nextState: QrCloudState): void {
  generation += 1;
  clearTimer();
  cancelInFlight();
  state = nextState;
}

/** Starts the connector when it is enabled, configured and configured to auto-start. */
export function startQrCloudConnector(options: { force?: boolean } = {}): void {
  const config = readConfig();
  stopLoop(state === 'DISABLED' ? 'DISABLED' : state);

  if (!config.enabled) {
    state = 'DISABLED';
    return;
  }
  if (!config.cloudUrl || !readConnectorSetting()) {
    state = 'NOT_CONFIGURED';
    return;
  }
  if (!options.force && !config.autoStart) {
    state = 'DISABLED';
    return;
  }
  startedAt = nowIso();
  failures = 0;
  state = 'CONNECTING';
  const current = generation;
  void pollOnce(current);
}

/** Stops polling and cancels an in-flight request. Safe to call when not running. */
export function stopQrCloudConnector(): void {
  stopLoop('STOPPING');
  state = 'DISABLED';
}

/** Shutdown hook: stop, flush and close the inbox file so the process can exit cleanly. */
export function shutdownQrCloudConnector(): void {
  stopLoop('STOPPING');
  state = 'DISABLED';
  closeInbox();
}

/**
 * Applies a settings patch and re-arms the loop only when the effective configuration changed.
 * Concurrent saves are serialised by a revision counter, so a burst of saves cannot leave two
 * polling loops behind.
 */
export function applyQrCloudConfig(patch: QrCloudConfigPatch): QrCloudConfig {
  applyRevision += 1;
  const revision = applyRevision;
  updateConfig(patch);
  const config = readConfig();
  if (revision !== applyRevision) return config; // a newer save already re-armed the loop
  if (config.enabled && config.cloudUrl && readConnectorSetting()) startQrCloudConnector();
  else stopQrCloudConnector();
  return config;
}

export function replaceQrCloudToken(token: unknown): void {
  writeConnectorToken(token);
  const config = readConfig();
  if (config.enabled && config.cloudUrl) startQrCloudConnector();
}

export function revokeQrCloudToken(): void {
  clearConnectorToken();
  stopQrCloudConnector();
}

export interface ConnectionTestResult {
  ok: boolean;
  code: string | null;
  detail: string | null;
  latency_ms: number | null;
  checked_at: string;
}

/** One isolated request with its own timeout; never starts or disturbs the polling loop. */
export async function testQrCloudConnection(): Promise<ConnectionTestResult> {
  const checkedAt = nowIso();
  const config = readConfig();
  const token = readConnectorSetting();
  if (!config.cloudUrl || !token)
    return {
      ok: false,
      code: 'not_configured',
      detail: null,
      latency_ms: null,
      checked_at: checkedAt,
    };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const ca = readApprovedCa();
    await fetchEventsImpl({ config, token, caPem: ca?.pem ?? null, signal: controller.signal });
    return {
      ok: true,
      code: null,
      detail: null,
      latency_ms: Date.now() - started,
      checked_at: checkedAt,
    };
  } catch (error) {
    const code = error instanceof QrCloudClientError ? error.code : 'offline';
    const detail = error instanceof QrCloudClientError ? (error.detail ?? null) : null;
    return { ok: false, code, detail, latency_ms: Date.now() - started, checked_at: checkedAt };
  } finally {
    clearTimeout(timeout);
  }
}

export interface QrCloudStatus {
  enabled: boolean;
  mode: string;
  state: QrCloudState;
  cloud_url: string;
  connection_mode: string;
  poll_interval_ms: number;
  auto_start: boolean;
  has_token: boolean;
  branch_identity: { tenant: string | null; branch: string | null; source: string };
  last_success_at: string | null;
  last_poll_at: string | null;
  last_event_count: number;
  last_error: ConnectorErrorEntry | null;
  inbox: InboxSummary;
  tls: ReturnType<typeof caStatus>;
  websocket: { available: boolean; reason: string };
  started_at: string | null;
}

export function getQrCloudStatus(): QrCloudStatus {
  const config = readConfig();
  return {
    enabled: config.enabled,
    mode: config.mode,
    state,
    cloud_url: config.cloudUrl,
    connection_mode: config.connectionMode,
    poll_interval_ms: config.pollIntervalMs,
    auto_start: config.autoStart,
    // Presence of a stored token is not proof of authentication; only a successful poll is.
    has_token: readConnectorSetting() !== '',
    branch_identity: {
      tenant: null,
      branch: null,
      source: 'not_exposed_by_cloud_api',
    },
    last_success_at: lastSuccessAt ?? getSettingValue(QR_CLOUD_SETTING_KEYS.lastSuccessAt) ?? null,
    last_poll_at: lastPollAt,
    last_event_count: lastEventCount,
    last_error: lastError,
    inbox: inboxSummary(),
    tls: caStatus(),
    websocket: { available: false, reason: 'cloud_wss_contract_not_deployed' },
    started_at: startedAt,
  };
}

export interface QrCloudDiagnostics {
  state: QrCloudState;
  failures: number;
  last_error: ConnectorErrorEntry | null;
  error_history: ConnectorErrorEntry[];
  recent_polls: ReturnType<typeof recentPolls>;
  inbox: InboxSummary;
  tls: ReturnType<typeof caStatus>;
  polling: {
    poll_interval_ms: number;
    timeout_ms: number;
    retry_max: number;
    reconcile_interval_ms: number;
  };
}

/** Diagnostics never include event payloads, customer data or the token. */
export function getQrCloudDiagnostics(): QrCloudDiagnostics {
  const config = readConfig();
  return {
    state,
    failures,
    last_error: lastError,
    error_history: [...errorHistory],
    recent_polls: recentPolls(20),
    inbox: inboxSummary(),
    tls: caStatus(),
    polling: {
      poll_interval_ms: config.pollIntervalMs,
      timeout_ms: config.timeoutMs,
      retry_max: config.retryMax,
      reconcile_interval_ms: config.reconcileIntervalMs,
    },
  };
}

/** Clears the non-sensitive error history only: events, statuses and payloads stay untouched. */
export function clearQrCloudErrorHistory(): number {
  const cleared = clearInboxErrors();
  errorHistory = [];
  lastError = null;
  upsertSettings({
    [QR_CLOUD_SETTING_KEYS.lastError]: '',
    [QR_CLOUD_SETTING_KEYS.lastErrorAt]: '',
  });
  return cleared;
}

/** Only used by tests: reports whether a loop is currently armed. */
export function __isLoopArmedForTests(): boolean {
  return loopTimer !== null || inFlight !== null;
}
