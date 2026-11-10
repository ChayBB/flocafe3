import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { readConnectorEventPage, readConnectorOrder } from './connector-order-source';

const testUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;

test.skipIf(!testUrl)('Cloud order reads enforce tenant, branch and pending delivery across pages', async () => {
  const url = new URL(testUrl!);
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) {
    throw new Error('A loopback PostgreSQL database ending in _test is required');
  }
  const db = postgres(testUrl!, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx`CREATE TEMP TABLE orders (id uuid, tenant_id uuid, branch_id uuid, table_session_id uuid,
        status text, created_at timestamptz DEFAULT now(), total_satang int) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE outbox_events (id uuid, tenant_id uuid, branch_id uuid, kind text,
        payload jsonb, created_at timestamptz DEFAULT now()) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE connector_deliveries (event_id uuid, tenant_id uuid, branch_id uuid,
        status text) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE table_sessions (id uuid, tenant_id uuid, branch_id uuid, table_id uuid, qr_generation uuid) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE dining_tables (id uuid, tenant_id uuid, branch_id uuid, name text,
        pos_table_id text, pos_installation_id uuid, qr_session_generation uuid, qr_ordering_until timestamptz) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE menu_items (id uuid, tenant_id uuid, branch_id uuid, external_id text,
        pos_product_id text, pos_variant_id text) ON COMMIT DROP`;
      await tx`CREATE TEMP TABLE order_items (id uuid, order_id uuid, menu_item_id uuid, name_snapshot text,
        quantity int, unit_price_satang int, note text, addons_snapshot jsonb NOT NULL DEFAULT '[]') ON COMMIT DROP`;

      const scope = { tenantId: randomUUID(), branchId: randomUUID() };
      const otherBranch = { ...scope, branchId: randomUUID() };
      const otherTenant = { tenantId: randomUUID(), branchId: randomUUID() };
      const { tenantId, branchId } = scope;
      const [table, session, menu, order, event] = Array.from({ length: 5 }, () => randomUUID());
      await tx`INSERT INTO dining_tables(id, tenant_id, branch_id, name, pos_table_id) VALUES (${table}, ${tenantId}, ${branchId}, 'Table 08', 'pos-table-08')`;
      await tx`INSERT INTO table_sessions(id, tenant_id, branch_id, table_id) VALUES (${session}, ${tenantId}, ${branchId}, ${table})`;
      await tx`INSERT INTO menu_items(id, tenant_id, branch_id, external_id) VALUES (${menu}, ${tenantId}, ${branchId}, 'pos-coffee-id')`;
      const addons = [{ id: 'oat', name: 'Oat milk', quantity: 1, price_satang: 500 }];
      await tx`INSERT INTO orders (id, tenant_id, branch_id, table_session_id, status, total_satang)
        VALUES (${order}, ${tenantId}, ${branchId}, ${session}, 'created', 8800)`;
      await tx`INSERT INTO order_items VALUES (${randomUUID()}, ${order}, ${menu}, 'Coffee', 2, 3900, 'Iced', ${tx.json(addons)})`;

      async function seed(id: string, eventScope = scope, status = 'pending', deliveryScope = eventScope) {
        await tx`INSERT INTO outbox_events (id, tenant_id, branch_id, kind, payload)
          VALUES (${id}, ${eventScope.tenantId}, ${eventScope.branchId}, 'order.created', ${tx.json({ order_id: order })})`;
        await tx`INSERT INTO connector_deliveries VALUES (${id}, ${deliveryScope.tenantId}, ${deliveryScope.branchId}, ${status})`;
      }

      await seed(event);
      const pendingIds = [event];
      for (let index = 0; index < 32; index++) {
        const id = randomUUID();
        pendingIds.push(id);
        await seed(id);
      }
      const wrongDelivery = randomUUID();
      const acknowledged = randomUUID();
      await seed(wrongDelivery, scope, 'pending', otherBranch);
      await seed(acknowledged, scope, 'acknowledged');
      const foreignEvent = randomUUID();
      await seed(foreignEvent, otherBranch);

      const first = await readConnectorEventPage(tx, scope, null);
      expect(first.events).toHaveLength(30);
      expect(first.next_cursor).toBe(first.events[29].id);
      const second = await readConnectorEventPage(tx, scope, first.next_cursor);
      expect(second.next_cursor).toBeNull();
      expect([...first.events, ...second.events].map(({ id }) => id)).toEqual(pendingIds.sort());
      expect((await readConnectorEventPage(tx, scope, foreignEvent)).events).toEqual([]);

      expect(await readConnectorOrder(tx, scope, event)).toMatchObject({
        order_id: order, table_name: 'Table 08', total_satang: 8800,
        items: [{ external_id: 'pos-coffee-id', name: 'Coffee', quantity: 2, unit_price_satang: 3900, note: 'Iced', addons }],
      });
      expect(await readConnectorOrder(tx, otherTenant, event)).toBeNull();
      expect(await readConnectorOrder(tx, otherBranch, event)).toBeNull();
      expect(await readConnectorOrder(tx, scope, wrongDelivery)).toBeNull();
      expect(await readConnectorOrder(tx, scope, acknowledged)).toBeNull();
      expect(await readConnectorOrder(tx, otherBranch, foreignEvent)).toBeNull();
      const [delivery] = await tx`SELECT status FROM connector_deliveries WHERE event_id = ${event}`;
      expect(delivery.status).toBe('pending');
      await tx`UPDATE orders SET status = 'cancelled' WHERE id = ${order}`;
      expect(await readConnectorOrder(tx, scope, event)).toBeNull();
    });
  } finally {
    await db.end();
  }
});
