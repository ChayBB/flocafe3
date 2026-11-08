import * as dns from 'node:dns';
import * as https from 'node:https';
import { isBlockedSsrfTarget } from '../../middleware/security';
import type { QrCloudConfig } from './config';

/**
 * The Cloud connector's only network client.
 *
 * It issues one bounded GET to the connector event feed. It has no code path that writes to the
 * Cloud: no ACK, no order mutation, no price change. TLS validation is always on; the approved
 * staging CA is supplied as an extra anchor for this hostname only.
 */

export const EVENTS_PATH = '/api/v1/connectors/events';
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
}

export interface FetchEventsOptions {
  config: QrCloudConfig;
  token: string;
  caPem?: string | null;
  signal?: AbortSignal;
}

function classifyNetworkError(error: NodeJS.ErrnoException): QrCloudClientError {
  const code = error.code ?? '';
  if (code === 'EBLOCKED') return new QrCloudClientError('blocked_target');
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return new QrCloudClientError('timeout');
  if (TLS_ERROR_CODES.has(code)) return new QrCloudClientError('tls_failed', code);
  if (OFFLINE_ERROR_CODES.has(code)) return new QrCloudClientError('offline', code);
  return new QrCloudClientError('offline', code || error.message);
}

/**
 * One bounded request. The response must be `{ events: [...] }`; anything else is `bad_response`.
 * Events above the per-poll cap are dropped and reported as a protocol violation.
 */
export async function fetchConnectorEvents(
  options: FetchEventsOptions,
): Promise<CloudEventsResponse> {
  const { config, token, caPem, signal } = options;
  if (!config.cloudUrl) throw new QrCloudClientError('not_configured');
  if (!token) throw new QrCloudClientError('not_configured');

  let url: URL;
  try {
    url = new URL(`${config.cloudUrl}${EVENTS_PATH}`);
  } catch {
    throw new QrCloudClientError('not_configured');
  }
  if (url.protocol !== 'https:') throw new QrCloudClientError('not_configured');

  const started = Date.now();
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
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'FloCafe-CloudConnector/1',
        },
        timeout: config.timeoutMs,
        ca: caPem ? [caPem] : undefined,
        lookup: guardedLookup as unknown as https.RequestOptions['lookup'],
        rejectUnauthorized: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) {
          response.resume();
          return finish(() => reject(new QrCloudClientError('auth_failed', `HTTP ${status}`)));
        }
        if (status >= 500) {
          response.resume();
          return finish(() => reject(new QrCloudClientError('server_error', `HTTP ${status}`)));
        }
        if (status !== 200) {
          response.resume();
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
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ETOOBIG')
        return finish(() => reject(new QrCloudClientError('bad_response', 'too_large')));
      finish(() => reject(classifyNetworkError(err)));
    });
    request.end();
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new QrCloudClientError('bad_response', 'invalid_json');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { events?: unknown }).events)
  )
    throw new QrCloudClientError('bad_response', 'unexpected_shape');
  const events = (parsed as { events: unknown[] }).events;
  if (events.length > MAX_EVENTS_PER_POLL)
    throw new QrCloudClientError('bad_response', 'too_many_events');
  return { events, status: 200, latencyMs: Date.now() - started };
}
