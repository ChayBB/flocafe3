import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { readPendingConnectorOrders } from './connector-notification-source';

const testUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;

test.skipIf(!testUrl)('PostgreSQL selects only pending, correctly scoped orders without mutating delivery', async () => {
  const url = new URL(testUrl!);
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) {
    throw new Error('A loopback PostgreSQL database ending in _test is required');
  }
  const db = postgres(testUrl!, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx`CREATE TEMP TABLE orders (id uuid, tenant_id uuid, branch_id uuid) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE outbox_events (
        id uuid, tenant_id uuid, branch_id uuid, kind text, payload jsonb, created_at timestamptz DEFAULT now()
      ) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE connector_deliveries (
        event_id uuid, tenant_id uuid, branch_id uuid, status text
      ) ON COMMIT DROP`;
      const scope = { tenantId: randomUUID(), branchId: randomUUID() };
      const otherTenant = { tenantId: randomUUID(), branchId: randomUUID() };
      const otherBranch = { ...scope, branchId: randomUUID() };
      async function seed(
        eventScope = scope, deliveryScope = eventScope, orderScope = eventScope,
        status = 'pending', kind = 'order.created', validOrderId = true,
      ) {
        const eventId = randomUUID();
        const orderId = randomUUID();
        await tx`INSERT INTO orders VALUES (${orderId}, ${orderScope.tenantId}, ${orderScope.branchId})`;
        await tx`INSERT INTO outbox_events (id, tenant_id, branch_id, kind, payload)
          VALUES (${eventId}, ${eventScope.tenantId}, ${eventScope.branchId}, ${kind},
            ${tx.json({ order_id: validOrderId ? orderId : 'malformed' })})`;
        await tx`INSERT INTO connector_deliveries VALUES
          (${eventId}, ${deliveryScope.tenantId}, ${deliveryScope.branchId}, ${status})`;
        return { event_id: eventId, delivery_id: eventId, order_id: orderId };
      }
      const expected = await seed();
      await seed(otherTenant);
      await seed(otherBranch);
      await seed(scope, otherBranch);
      await seed(scope, scope, otherTenant);
      await seed(scope, scope, scope, 'acknowledged');
      await seed(scope, scope, scope, 'pending', 'order.status');
      await seed(scope, scope, scope, 'pending', 'order.created', false);
      expect(Array.from(await readPendingConnectorOrders(tx, scope, 64))).toEqual([expected]);
      const [row] = await tx`SELECT status FROM connector_deliveries WHERE event_id = ${expected.event_id}`;
      expect(row.status).toBe('pending');
    });
  } finally {
    await db.end();
  }
});
