import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { bearer, constantEqual } from '../../../packages/shared/src/index';
import {
  connectorNotificationPath,
  connectorNotifications,
  connectorWebSocketOptions,
  type ConnectorScope,
} from './connector-notifications';

const token = 'integration-test-connector-secret';
const scope = { tenantId: randomUUID(), branchId: randomUUID() };
const stop: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of stop.reverse()) await close();
  stop.length = 0;
});

function fixture(sweepMs = 60_000) {
  const rows: Array<ConnectorScope & { event_id: string; delivery_id: string; order_id: string }> = [];
  let wake: (() => void) | undefined;
  let scans = 0;
  const app = new Elysia({ websocket: connectorWebSocketOptions }).use(connectorNotifications({
    scope,
    authenticate: (request) => constantEqual(bearer(request), token),
    async readPending({ tenantId, branchId }, limit) {
      scans++;
      return rows.filter((row) => row.tenantId === tenantId && row.branchId === branchId).slice(0, limit);
    },
    subscribe(listener) {
      wake = listener;
      return () => { wake = undefined; };
    },
    sweepMs,
  })).listen({ port: 0, hostname: '127.0.0.1' });
  stop.push(async () => { await app.stop(true); });
  const origin = `127.0.0.1:${app.server!.port}`;
  return {
    origin,
    add(overrides: Partial<ConnectorScope & { order_id: string }> = {}) {
      const event_id = randomUUID();
      const row = { ...scope, event_id, delivery_id: event_id, order_id: randomUUID(), ...overrides };
      rows.push(row);
      return row;
    },
    signal: () => wake?.(),
    scans: () => scans,
  };
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(15);
  }
  throw new Error('Timed out waiting for notifications');
}

async function connect(origin: string, suffix = '') {
  const messages: unknown[] = [];
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(`ws://${origin}${connectorNotificationPath}${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket.onmessage = (message) => messages.push(JSON.parse(String(message.data)));
  stop.push(() => socket.close());
  await until(() => socket.readyState === WebSocket.OPEN);
  return { socket, messages };
}

test('rejects missing, invalid and query-string credentials before upgrade', async () => {
  const { origin } = fixture();
  for (const authorization of ['', 'Bearer wrong-token', token]) {
    const res = await fetch(`http://${origin}${connectorNotificationPath}?token=${token}`, {
      headers: {
        Authorization: authorization,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    expect(res.status).toBe(401);
  }
});

test('uses configured tenant and branch, validates IDs and emits only the notification fields', async () => {
  const relay = fixture();
  const other = relay.add({ tenantId: randomUUID(), branchId: randomUUID() });
  relay.add({ branchId: randomUUID() });
  relay.add({ order_id: 'invalid' });
  const own = relay.add();
  const { messages } = await connect(
    relay.origin,
    `?tenant_id=${other.tenantId}&branch_id=${other.branchId}`,
  );
  await until(() => messages.length > 0);
  expect(messages).toEqual([{
    type: 'order.available', version: 1,
    event_id: own.event_id, delivery_id: own.delivery_id, order_id: own.order_id,
  }]);
});

test('deduplicates repeated signals per connection and replays pending events on reconnect', async () => {
  const relay = fixture();
  relay.add();
  const first = await connect(relay.origin);
  await until(() => first.messages.length === 1);
  const scans = relay.scans();
  relay.signal();
  relay.signal();
  await until(() => relay.scans() > scans);
  expect(first.messages).toHaveLength(1);
  first.socket.close();
  const second = await connect(relay.origin);
  await until(() => second.messages.length === 1);
  expect(second.messages).toEqual(first.messages);
});

test('recovers a missed Redis signal using the PostgreSQL sweep', async () => {
  const relay = fixture(200);
  const { messages } = await connect(relay.origin);
  await until(() => relay.scans() > 0);
  const event = relay.add();
  await until(() => messages.length === 1);
  expect(messages[0]).toMatchObject({ event_id: event.event_id });
});
