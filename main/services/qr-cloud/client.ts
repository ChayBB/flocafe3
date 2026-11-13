import * as dns from 'node:dns';
import * as https from 'node:https';
import { isBlockedSsrfTarget } from '../../middleware/security';
import { normalizeCloudUrl, QrCloudConfigError, type QrCloudConfig } from './config';

/**
 * The Cloud connector's only network client.
 *
 * It reads the event feed and order details and manages explicitly opened table QR sessions.
 * TLS validation is always on; the approved
 * staging CA is supplied as an extra anchor for this hostname only.
 */

export const EVENTS_PATH = '/api/v1/connectors/events';
export const CONNECTOR_EVENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_EVENTS_PER_POLL = 200;

export type QrCloudErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'tls_failed'
  | 'offline'
  | 'timeout'
  | 'server_error'
  | 'bad_response'
  | 'blocked_target'
  | 'inbox_error';

export class QrCloudClientError extends Error {
  constructor(
    public code: QrCloudErrorCode,
    public detail?: string,
  ) {
    super(code);
  }
}

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);

const OFFLINE_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ECONNABORTED',
]);

/** Every lookup refuses a name that resolves inside the shop, this host or a metadata range. */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (addresses.length === 0 || addresses.some(({ address }) => isBlockedSsrfTarget(address))) {
      const blocked: NodeJS.ErrnoException = new Error(
        'Cloud host resolves to a disallowed address',
      );
      blocked.code = 'EBLOCKED';
      return callback(blocked, '');
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export interface CloudEventsResponse {
  events: unknown[];
  status: number;
  latencyMs: number;
  nextCursor?: string;
  scope?: { tenant_id: string; branch_id: string };
}

export interface FetchEventsOptions {
  config: QrCloudConfig;
  token: string;
  caPem?: string | null;
  signal?: AbortSignal;
  after?: string;
}

function classifyNetworkError(error: NodeJS.ErrnoException): QrCloudClientError {
  const code = error.code ?? '';
  if (code === 'EBLOCKED') return new QrCloudClientError('blocked_target');
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return new QrCloudClientError('timeout');
  if (TLS_ERROR_CODES.has(code)) return new QrCloudClientError('tls_failed', code);
  if (OFFLINE_ERROR_CODES.has(code)) return new QrCloudClientError('offline', code);
  return new QrCloudClientError('offline', code || undefined);
}

async function requestConnectorJson(
  options: FetchEventsOptions,
  endpoint: string,
  json?: string,
): Promise<unknown> {
  const { config, token, caPem, signal } = options;
  if (!config.cloudUrl) throw new QrCloudClientError('not_configured');
  if (!token) throw new QrCloudClientError('not_configured');

  let url: URL;
  try {
    url = new URL(`${normalizeCloudUrl(config.cloudUrl)}${endpoint}`);
  } catch (error) {
    if (error instanceof QrCloudConfigError && error.code === 'cloud_url_private_target')
      throw new QrCloudClientError('blocked_target');
    throw new QrCloudClientError('not_configured');
  }
  if (url.protocol !== 'https:') throw new QrCloudClientError('not_configured');

  const body = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const request = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: json === undefined ? 'GET' : 'POST',
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'FloCafe-CloudConnector/1',
          ...(json === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(json),
              }),
        },
        timeout: config.timeoutMs,
        ca: caPem ? [caPem] : undefined,
        lookup: guardedLookup as unknown as https.RequestOptions['lookup'],
        rejectUnauthorized: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) {
          response.destroy();
          return finish(() => reject(new QrCloudClientError('auth_failed', `HTTP ${status}`)));
        }
        if (status >= 500) {
          response.destroy();
          return finish(() => reject(new QrCloudClientError('server_error', `HTTP ${status}`)));
        }
        if (status !== 200) {
          response.destroy();
          return finish(() => reject(new QrCloudClientError('bad_response', `HTTP ${status}`)));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(Object.assign(new Error('response too large'), { code: 'ETOOBIG' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
        response.on('error', (error) =>
          finish(() => reject(classifyNetworkError(error as NodeJS.ErrnoException))),
        );
      },
    );
    const onAbort = () => {
      request.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      finish(() => reject(new QrCloudClientError('timeout', 'cancelled')));
    };
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ETOOBIG')
        return finish(() => reject(new QrCloudClientError('bad_response', 'too_large')));
      finish(() => reject(classifyNetworkError(err)));
    });
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    request.end(json);
  });

  try {
    return JSON.parse(body);
  } catch {
    throw new QrCloudClientError('bad_response', 'invalid_json');
  }
}

export function fetchConnectorOrder(
  options: FetchEventsOptions,
  eventId: string,
): Promise<unknown> {
  if (!CONNECTOR_EVENT_ID.test(eventId)) throw new QrCloudClientError('bad_response');
  return requestConnectorJson(options, `${EVENTS_PATH}/${eventId}/order?addons=1`);
}

export function manageConnectorTableQr(
  options: FetchEventsOptions,
  table: {
    action: 'open' | 'close' | 'payment-state';
    pos_table_id: string;
    name: string;
    awaiting_payment?: boolean;
  },
): Promise<unknown> {
  return requestConnectorJson(options, '/api/v1/connectors/table-qr', JSON.stringify(table));
}

export function syncConnectorTableStates(
  options: FetchEventsOptions,
  tables: { pos_table_id: string; name: string; active: boolean; awaiting_payment: boolean }[],
): Promise<unknown> {
  return requestConnectorJson(
    options,
    '/api/v1/connectors/table-states',
    JSON.stringify({ tables }),
  );
}

export function acknowledgeConnectorOrder(
  options: FetchEventsOptions,
  receipt: {
    event_id: string;
    cloud_order_id: string;
    pos_receipt_id: string;
    pos_order_number: string;
  },
): Promise<unknown> {
  return requestConnectorJson(options, '/api/v1/connectors/ack-receipt', JSON.stringify(receipt));
}

export function reportConnectorKitchenStatus(
  options: FetchEventsOptions,
  report: { order_id: string; statuses: string[] },
): Promise<unknown> {
  return requestConnectorJson(options, '/api/v1/connectors/order-status', JSON.stringify(report));
}

export function connectorGuestSettings(
  options: FetchEventsOptions,
  settings?: { scroll_percent: number },
): Promise<unknown> {
  return requestConnectorJson(
    options,
    '/api/v1/connectors/guest-settings',
    settings && JSON.stringify(settings),
  );
}

export function readConnectorCapabilities(options: FetchEventsOptions): Promise<unknown> {
  return requestConnectorJson(options, '/api/v1/connectors/capabilities');
}

export function connectorCatalog(
  options: FetchEventsOptions,
  catalog?: {
    revision: string;
    base_revision: string | null;
    items: unknown[];
  },
): Promise<unknown> {
  return requestConnectorJson(
    options,
    '/api/v1/connectors/catalog',
    catalog && JSON.stringify(catalog),
  );
}

export async function fetchConnectorEvents(
  options: FetchEventsOptions,
): Promise<CloudEventsResponse> {
  const started = Date.now();
  const after = options.after;
  if (after && !CONNECTOR_EVENT_ID.test(after)) throw new QrCloudClientError('bad_response');
  const parsed = await requestConnectorJson(
    options,
    after ? `${EVENTS_PATH}?after=${after}` : EVENTS_PATH,
  );
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { events?: unknown }).events)
  )
    throw new QrCloudClientError('bad_response', 'unexpected_shape');
  const {
    events,
    next_cursor: cursor,
    scope,
  } = parsed as {
    events: unknown[];
    next_cursor?: unknown;
    scope?: { tenant_id?: unknown; branch_id?: unknown };
  };
  if (events.length > MAX_EVENTS_PER_POLL)
    throw new QrCloudClientError('bad_response', 'too_many_events');
  if (
    cursor != null &&
    (typeof cursor !== 'string' ||
      !CONNECTOR_EVENT_ID.test(cursor) ||
      cursor === after ||
      (events.at(-1) as { id?: unknown } | null)?.id !== cursor)
  ) {
    throw new QrCloudClientError('bad_response', 'invalid_cursor');
  }
  if (
    scope !== undefined &&
    (!scope ||
      typeof scope.tenant_id !== 'string' ||
      typeof scope.branch_id !== 'string' ||
      !CONNECTOR_EVENT_ID.test(scope.tenant_id) ||
      !CONNECTOR_EVENT_ID.test(scope.branch_id))
  ) {
    throw new QrCloudClientError('bad_response', 'invalid_scope');
  }
  return {
    events,
    status: 200,
    latencyMs: Date.now() - started,
    nextCursor: cursor ?? undefined,
    scope: scope && { tenant_id: scope.tenant_id as string, branch_id: scope.branch_id as string },
  };
}
