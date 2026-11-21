import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { inTenant } from './tenant-scope';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'two shops on one Cloud never see or change each other’s rows',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `tenant_rls_${randomUUID().replaceAll('-', '')}`;
    let api: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema}, public`);
      for (const file of [...new Bun.Glob('*.sql').scanSync('db/migrations')].sort()) {
        await sql.begin(async (tx) => {
          await tx.unsafe(await Bun.file(`db/migrations/${file}`).text());
        });
      }
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set('options', `-csearch_path=${schema},public`);
      const admin = 'fixture-admin-tenant-isolation-only';
      api = Bun.spawn([process.execPath, 'run', 'apps/api/src/index.ts'], {
        env: {
          ...process.env,
          DATABASE_URL: scoped.href,
          REDIS_URL: redisUrl!,
          PORT: '0',
          ADMIN_BOOTSTRAP_TOKEN: admin,
          ALLOW_LEGACY_CONNECTOR_TOKEN: 'false',
          QR_ORDERING_PUBLIC_ORIGIN: 'https://ordering.example.test',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const errors = new Response(api.stderr).text();
      const reader = api.stdout.getReader();
      let output = '';
      const port = await Promise.race([
        (async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) throw Error(`Cloud API did not start: ${await errors}`);
            output += new TextDecoder().decode(value);
            const matched = /QR API listening (\d+)/.exec(output);
            if (matched) return matched[1];
          }
        })(),
        Bun.sleep(10000).then(() => {
          throw Error('Cloud API startup timed out');
        }),
      ]);
      const base = `http://127.0.0.1:${port}`;
      const call = async (path: string, bearer: string, body?: object, headers: Record<string, string> = {}) => {
        const response = await fetch(`${base}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };

      const shop = async (name: string, dish: string) => {
        const tenant = (await call('/api/v1/admin/tenants', admin, { name })).body;
        const branch = (await call('/api/v1/admin/branches', admin, { tenant_id: tenant.id, name: 'Main' })).body;
        const issued = await call('/api/v1/admin/connector-installations/token', admin, {
          tenant_id: tenant.id, branch_id: branch.id, label: `${name} POS`,
          scopes: ['orders.read', 'orders.ack', 'tables.write', 'catalog.write'],
        });
        expect(issued.status).toBe(200);
        const connector = issued.body.connector_token as string;
        const revision = randomUUID();
        const published = await call('/api/v1/connectors/catalog', connector, {
          revision, base_revision: null,
          items: [{ external_id: 'dish', pos_product_id: 'dish', pos_variant_id: null, name: dish, category: null, price_satang: 5000 }],
        });
        expect(published.status).toBe(200);
        expect((await call('/api/v1/connectors/catalog', connector)).body).toEqual({ revision });
        expect((await call('/api/v1/connectors/guest-settings', connector, { scroll_percent: 80 })).body)
          .toEqual({ scroll_percent: 80 });
        const opened = await call('/api/v1/connectors/table-qr', connector, { action: 'open', pos_table_id: '1', name: '1' });
        expect(opened.status).toBe(200);
        const tableKey = new URLSearchParams(new URL(opened.body.url).hash.slice(1)).get('table')!;
        const joined = await fetch(`${base}/api/v1/table-qr/session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table_key: tableKey }),
        });
        const guest = (await joined.json()).table_token as string;
        const menu = await call('/api/v1/menu', guest);
        expect(menu.body.items.map((item: { name: string }) => item.name)).toEqual([dish]);
        const ordered = await call('/api/v1/orders', guest,
          { menu_revision: revision, items: [{ menu_item_id: menu.body.items[0].id, quantity: 1 }] },
          { 'Idempotency-Key': randomUUID() });
        expect(ordered.status).toBe(200);
        return { tenantId: tenant.id, branchId: branch.id, connector, guest, orderId: ordered.body.order_id as string };
      };
      const north = await shop('North shop', 'Khao man gai');
      const south = await shop('South shop', 'Khao mok gai');

      await sql.begin(async (tx) => {
        const events = await tx`SELECT id,tenant_id,branch_id FROM outbox_events WHERE published_at IS NULL`;
        for (const e of events) {
          await tx`INSERT INTO connector_deliveries(event_id,tenant_id,branch_id) VALUES (${e.id},${e.tenant_id},${e.branch_id})`;
          await tx`UPDATE outbox_events SET published_at=now() WHERE id=${e.id}`;
        }
      });
      const eventOf = async (orderId: string) =>
        (await sql`SELECT id FROM outbox_events WHERE payload->>'order_id'=${orderId}`)[0].id as string;
      const northEvent = await eventOf(north.orderId);
      const southEvent = await eventOf(south.orderId);

      const listed = await call('/api/v1/connectors/events', north.connector);
      expect(listed.body.events.map((event: { id: string }) => event.id)).toEqual([northEvent]);
      expect((await call(`/api/v1/connectors/events/${southEvent}/order`, north.connector)).status).toBe(404);
      expect((await call(`/api/v1/connectors/events/${northEvent}/order`, north.connector)).status).toBe(200);
      const receipt = (eventId: string, orderId: string) => ({
        event_id: eventId, cloud_order_id: orderId, pos_receipt_id: randomUUID(), pos_order_number: 'A1',
      });
      expect((await call('/api/v1/connectors/ack-receipt', north.connector, receipt(southEvent, south.orderId))).status).toBe(404);
      expect((await call('/api/v1/connectors/ack-receipt', north.connector, receipt(northEvent, north.orderId))).status).toBe(200);
      expect((await call('/api/v1/connectors/order-status', north.connector, { order_id: south.orderId, statuses: ['ready'] })).status).toBe(404);
      expect((await call('/api/v1/connectors/order-status', north.connector, { order_id: north.orderId, statuses: ['ready'] })).status).toBe(200);
      expect((await call(`/api/v1/orders/${south.orderId}`, north.guest)).status).toBe(404);
      expect((await call(`/api/v1/orders/${north.orderId}`, north.guest)).body.status).toBe('ready');
      expect((await call('/api/v1/table-session/orders', north.guest)).body.orders.map((o: { id: string }) => o.id))
        .toEqual([north.orderId]);
      expect((await sql`SELECT status FROM orders WHERE id=${south.orderId}`)[0].status).toBe('created');

      const northRows: Record<string, string> = {
        tenants: `id = '${north.tenantId}'`,
        branches: `id = '${north.branchId}'`,
        order_items: `order_id IN (SELECT id FROM orders WHERE branch_id = '${north.branchId}')`,
      };
      for (const table of ['tenants', 'branches', 'dining_tables', 'table_sessions', 'menu_items', 'orders',
        'order_items', 'idempotency_records', 'outbox_events', 'connector_deliveries', 'audit_logs', 'connector_installations']) {
        const filter = northRows[table] ?? `tenant_id = '${north.tenantId}' AND branch_id = '${north.branchId}'`;
        const [visible] = await inTenant(sql, north, (tx) => tx.unsafe(`SELECT COUNT(*)::int AS count FROM ${table}`));
        const [own] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${filter}`);
        const [all] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM ${table}`);
        expect({ table, visible: visible.count }).toEqual({ table, visible: own.count });
        if (table !== 'audit_logs') expect(all.count).toBeGreaterThan(own.count);
      }
      const rejected = await inTenant(sql, north, (tx) =>
        tx`INSERT INTO menu_items(tenant_id,branch_id,external_id,name,price_satang)
           VALUES (${south.tenantId},${south.branchId},'planted','Planted',1)`).catch((error) => error.code);
      expect(rejected).toBe('42501');
      const unscoped = await inTenant(sql, { tenantId: north.tenantId }, (tx) => tx`SELECT COUNT(*)::int AS count FROM orders`);
      expect(unscoped[0].count).toBe(0);
    } finally {
      if (api) {
        api.kill();
        await api.exited;
      }
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
  30000,
);
