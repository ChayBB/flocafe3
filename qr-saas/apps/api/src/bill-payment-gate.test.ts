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
      for (const file of [...new Bun.Glob('*.sql').scanSync('db/migrations')].sort()) {
        await sql.begin(async (tx) => {
          await tx.unsafe(await Bun.file(`db/migrations/${file}`).text());
        });
      }
      const [tenant] =
        await sql`INSERT INTO tenants(name) VALUES ('Payment gate fixture') RETURNING id`;
      const [branch] =
        await sql`INSERT INTO branches(tenant_id,name) VALUES (${tenant.id},'Fixture') RETURNING id`;
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
      const opened = await manage({ action: 'open', awaiting_payment: false });
      expect(opened.status).toBe(200);
      const tableKey = new URLSearchParams(new URL((await opened.json()).url).hash.slice(1)).get(
        'table',
      );
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
      expect((await manage({ action: 'payment-state', awaiting_payment: true })).status).toBe(200);
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
      expect((await manage({ action: 'payment-state', awaiting_payment: false })).status).toBe(200);
      expect((await order(randomUUID())).status).toBe(200);
      expect((await sql`SELECT COUNT(*)::int AS count FROM orders`)[0].count).toBe(2);
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
