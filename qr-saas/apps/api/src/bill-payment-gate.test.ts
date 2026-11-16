import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'printed bills block new Cloud orders without breaking accepted replays',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `bill_gate_${randomUUID().replaceAll('-', '')}`;
    let api: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema}, public`);
      for (const file of [...new Bun.Glob('*.sql').scanSync('db/migrations')].sort().filter(file => file !== '011_table_active_orders.sql')) {
        await sql.begin(async (tx) => {
          await tx.unsafe(await Bun.file(`db/migrations/${file}`).text());
        });
      }
      const [tenant] =
        await sql`INSERT INTO tenants(name) VALUES ('Payment gate fixture') RETURNING id`;
      const [branch] =
        await sql`INSERT INTO branches(tenant_id,name) VALUES (${tenant.id},'Fixture') RETURNING id`;
      const [legacy] = await sql`INSERT INTO dining_tables(tenant_id,branch_id,name) VALUES (${tenant.id},${branch.id},'Existing table') RETURNING id`;
      await sql.unsafe(await Bun.file('db/migrations/011_table_active_orders.sql').text());
      const [upgraded] = await sql`SELECT name,pos_active_order_numbers FROM dining_tables WHERE id=${legacy.id}`;
      expect(upgraded).toEqual({ name: 'Existing table', pos_active_order_numbers: null });
      const [item] =
        await sql`INSERT INTO menu_items(tenant_id,branch_id,external_id,name,price_satang)
      VALUES (${tenant.id},${branch.id},'rice','Rice',5000) RETURNING id`;
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set('options', `-csearch_path=${schema},public`);
      const connector = 'fixture-connector-payment-gate-only';
      api = Bun.spawn([process.execPath, 'run', 'apps/api/src/index.ts'], {
        env: {
          ...process.env,
          DATABASE_URL: scoped.href,
          REDIS_URL: redisUrl!,
          PORT: '0',
          ADMIN_BOOTSTRAP_TOKEN: 'fixture-admin-payment-gate-only',
          ALLOW_LEGACY_CONNECTOR_TOKEN: 'true',
          CONNECTOR_TOKEN: connector,
          CONNECTOR_TENANT_ID: tenant.id,
          CONNECTOR_BRANCH_ID: branch.id,
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
      const table = { pos_table_id: '27', name: '27' };
      const manage = (body: object, authorized = true) =>
        fetch(`${base}/api/v1/connectors/table-qr`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authorized ? { Authorization: `Bearer ${connector}` } : {}),
          },
          body: JSON.stringify({ ...table, ...body }),
        });
      const sync = (active: boolean, awaiting_payment: boolean, authorized = true, active_order_numbers?: string[]) =>
        fetch(`${base}/api/v1/connectors/table-states`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authorized ? { Authorization: `Bearer ${connector}` } : {}),
          },
          body: JSON.stringify({ tables: [{ ...table, active, awaiting_payment, active_order_numbers }] }),
        });
      const opened = await manage({ action: 'open', awaiting_payment: false });
      expect(opened.status).toBe(200);
      const tableKey = new URLSearchParams(new URL((await opened.json()).url).hash.slice(1)).get(
        'table',
      );
      expect((await manage({ action: 'close' })).status).toBe(200);
      expect((await sync(true, false, false)).status).toBe(401);
      expect((await sync(true, false)).status).toBe(200);
      const joined = await fetch(`${base}/api/v1/table-qr/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_key: tableKey }),
      });
      expect(joined.status).toBe(200);
      const token = (await joined.json()).table_token;
      const order = (key: string) =>
        fetch(`${base}/api/v1/orders`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({ items: [{ menu_item_id: item.id, quantity: 1 }] }),
        });
      const key = randomUUID();
      const accepted = await order(key);
      expect(accepted.status).toBe(200);
      const orderId = (await accepted.json()).order_id;
      expect(
        (await manage({ action: 'payment-state', awaiting_payment: true }, false)).status,
      ).toBe(401);
      expect((await sync(true, true)).status).toBe(200);
      expect((await manage({ action: 'open' })).status).toBe(200);
      const blocked = await order(randomUUID());
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).code).toBe('bill_awaiting_payment');
      const replay = await order(key);
      expect(await replay.json()).toMatchObject({ order_id: orderId, replayed: true });
      const history = await fetch(`${base}/api/v1/table-session/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect((await history.json()).bill_awaiting_payment).toBe(true);
      expect((await sql`SELECT COUNT(*)::int AS count FROM orders`)[0].count).toBe(1);
      expect(
        (await sql`SELECT COUNT(*)::int AS count FROM outbox_events WHERE kind='order.created'`)[0]
          .count,
      ).toBe(1);
      const [event] = await sql`SELECT id FROM outbox_events WHERE payload->>'order_id'=${orderId}`;
      await sql`INSERT INTO connector_deliveries(event_id,tenant_id,branch_id,status,pos_receipt_id,pos_order_number)
        VALUES (${event.id},${tenant.id},${branch.id},'acknowledged',${randomUUID()},'POS-OLD')`;
      await sql`UPDATE orders SET status='served' WHERE id=${orderId}`;
      const historyOrders = async () => (await (await fetch(`${base}/api/v1/table-session/orders`, { headers: { Authorization: `Bearer ${token}` } })).json()).orders;
      expect((await sync(true, false, true, ['POS-OLD'])).status).toBe(200);
      expect((await historyOrders()).map((row: { id: string }) => row.id)).toContain(orderId);
      expect((await sync(true, false, true, [])).status).toBe(200);
      expect(await historyOrders()).toEqual([]);
      expect((await sql`SELECT COUNT(*)::int AS count FROM orders WHERE id=${orderId}`)[0].count).toBe(1);
      const next = await order(randomUUID());
      expect(next.status).toBe(200);
      const nextId = (await next.json()).order_id;
      const [nextEvent] = await sql`SELECT id FROM outbox_events WHERE payload->>'order_id'=${nextId}`;
      await sql`INSERT INTO connector_deliveries(event_id,tenant_id,branch_id,status,pos_receipt_id,pos_order_number,acknowledged_at)
        VALUES (${nextEvent.id},${tenant.id},${branch.id},'acknowledged',${randomUUID()},'POS-NEW',now())`;
      await sql`UPDATE orders SET status='pos_accepted',created_at=now()-interval '1 hour' WHERE id=${nextId}`;
      expect((await historyOrders()).map((row: { id: string }) => row.id)).toEqual([nextId]);
      expect((await (await order(key)).json()).order_id).toBe(orderId);
      expect((await sync(true, false)).status).toBe(200);
      expect((await historyOrders()).map((row: { id: string }) => row.id)).toEqual([nextId]);
      expect((await sql`SELECT COUNT(*)::int AS count FROM orders`)[0].count).toBe(2);
      expect((await sync(false, false)).status).toBe(200);
      expect((await order(randomUUID())).status).toBe(401);
      const join = () =>
        fetch(`${base}/api/v1/table-qr/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table_key: tableKey }),
        });
      expect((await join()).status).toBe(409);
      expect((await sync(true, false)).status).toBe(200);
      expect((await join()).status).toBe(200);
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
