import { Elysia } from 'elysia';

export const connectorNotificationPath = '/api/v1/connectors/notifications';
export const connectorWebSocketOptions = {
  idleTimeout: 30,
  sendPings: true,
  maxPayloadLength: 1024,
  backpressureLimit: 32 * 1024,
  closeOnBackpressureLimit: true,
};
const eventWindow = 64;
const maxPeers = 32;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface ConnectorScope {
  tenantId: string;
  branchId: string;
}

interface NotificationSource {
  scope: ConnectorScope;
  authenticate(request: Request): boolean | Promise<boolean>;
  readPending(scope: ConnectorScope, limit: number): Promise<readonly unknown[]>;
  subscribe(wake: () => void): () => void;
  sweepMs?: number;
}

interface Peer {
  sendText(text: string): number;
  close(code: number, reason: string): void;
  seen: Set<string>;
}

function notification(row: unknown) {
  if (typeof row !== 'object' || row === null) return null;
  const { event_id, delivery_id, order_id } = row as Record<string, unknown>;
  if (
    typeof event_id !== 'string' || !uuid.test(event_id) ||
    typeof delivery_id !== 'string' || !uuid.test(delivery_id) ||
    typeof order_id !== 'string' || !uuid.test(order_id)
  ) return null;
  return { type: 'order.available', version: 1, event_id, delivery_id, order_id };
}

export function connectorNotifications(source: NotificationSource) {
  const { scope } = source;
  const scopeConfigured = uuid.test(scope.tenantId) && uuid.test(scope.branchId);
  const peers = new Map<string, Peer>();
  let scanning = false;
  let failed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  async function refresh() {
    if (scanning || peers.size === 0) return;
    scanning = true;
    try {
      const rows = await source.readPending(scope, eventWindow);
      const events = rows.slice(0, eventWindow).map(notification).filter((event) => event !== null);
      const pendingIds = new Set(events.map((event) => event.event_id));
      for (const [id, peer] of peers) {
        for (const seen of peer.seen) {
          if (!pendingIds.has(seen)) peer.seen.delete(seen);
        }
        for (const event of events) {
          if (peer.seen.has(event.event_id)) continue;
          if (peer.sendText(JSON.stringify(event)) <= 0) {
            peers.delete(id);
            peer.close(1013, 'Retry with polling');
            break;
          }
          peer.seen.add(event.event_id);
        }
      }
      failed = false;
    } catch {
      if (!failed) console.error('Connector notification refresh failed');
      failed = true;
    } finally {
      scanning = false;
    }
  }

  const wake = () => {
    if (wakeTimer || peers.size === 0) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void refresh();
    }, 100);
  };
  return new Elysia({ name: 'connector-notifications' })
    .onStart(() => {
      unsubscribe = source.subscribe(wake);
      timer = setInterval(wake, source.sweepMs ?? 5_000);
    })
    .onStop(() => {
      clearInterval(timer);
      clearTimeout(wakeTimer);
      unsubscribe?.();
      for (const peer of peers.values()) peer.close(1001, 'Server stopping');
      peers.clear();
    })
    .ws(connectorNotificationPath, {
      async beforeHandle({ request, status }) {
        const authorization = request.headers.get('authorization') ?? '';
        if (!/^Bearer [^\s]+$/i.test(authorization) || !(await source.authenticate(request))) {
          return status(401, { error: 'unauthorized' });
        }
        if (!scopeConfigured || peers.size >= maxPeers) {
          return status(503, { error: 'notifications unavailable' });
        }
      },
      open(ws) {
        if (peers.size >= maxPeers) {
          ws.close(1013, 'Retry with polling');
          return;
        }
        peers.set(ws.id, {
          sendText: (text) => ws.raw.sendText(text),
          close: (code, reason) => ws.close(code, reason),
          seen: new Set(),
        });
        wake();
      },
      message(ws) {
        ws.close(1008, 'Notifications are read only');
      },
      close(ws) {
        peers.delete(ws.id);
      },
    });
}
