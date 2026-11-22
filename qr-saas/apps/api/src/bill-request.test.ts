import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'a Cloud guest asks for the bill; the POS picks it up with its table sync',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `bill_request_${randomUUID().replaceAll('-', '')}`;
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
        await sql`INSERT INTO tenants(name) VALUES ('Bill request fixture') RETURNING id`;
      const [branch] =
        await sql`INSERT INTO branches(tenant_id,name) VALUES (${tenant.id},'Fixture') RETURNING id`;
      const [item] =
        await sql`INSERT INTO menu_items(tenant_id,branch_id,external_id,name,price_satang)
      VALUES (${tenant.id},${branch.id},'rice','Rice',5000) RETURNING id`;
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set('options', `-csearch_path=${schema},public`);
      const connector = 'fixture-connector-bill-request-only';
      api = Bun.spawn([process.execPath, 'run', 'apps/api/src/index.ts'], {
        env: {
          ...process.env,
          DATABASE_URL: scoped.href,
          REDIS_URL: redisUrl!,
          PORT: '0',
          ADMIN_BOOTSTRAP_TOKEN: 'fixture-admin-bill-request-only',
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
      const table = { pos_table_id: '26', name: '26' };
      const post = (path: string, body: object, bearer?: string) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body),
        });
      const snapshot = {
        order_number: 'ORD-26',
        items: [
          { id: 1, product_id: 'p', product_name: 'Rice', quantity: 2, status: 'served', total: 100,
            ordered_by: null, ordered_by_guest: true },
        ],
        bill: { subtotal: 100, discount_amount: 0, service_charge: 0, tax_amount: 7,
          tax_included: false, round_off: 0, total: 107 },
      };
      const sync = (extra: object = {}, tableExtra: object = {}) =>
        post('/api/v1/connectors/table-states', {
          tables: [{ ...table, active: true, awaiting_payment: false, ...tableExtra }],
          ...extra,
        }, connector);
      const opened = await post('/api/v1/connectors/table-qr', { ...table, action: 'open', awaiting_payment: false }, connector);
      expect(opened.status).toBe(200);
      const tableKey = new URLSearchParams(new URL((await opened.json()).url).hash.slice(1)).get('table');
      const joined = await post('/api/v1/table-qr/session', { table_key: tableKey });
      const token = (await joined.json()).table_token as string;
      const ask = (bearer = token) => post('/api/v1/table-session/bill-request', {}, bearer);
      const history = async () =>
        (await fetch(`${base}/api/v1/table-session/orders`, { headers: { Authorization: `Bearer ${token}` } })).json();

      expect((await ask('')).status).toBe(401);
      expect((await ask('not-a-session')).status).toBe(401);
      const empty = await ask();
      expect(empty.status).toBe(409);
      expect((await empty.json()).code).toBe('no_open_order');

      const order = (key: string) =>
        fetch(`${base}/api/v1/orders`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ items: [{ menu_item_id: item.id, quantity: 1 }] }),
        });
      expect((await order(randomUUID())).status).toBe(200);
      expect((await sync({}, { bill: snapshot })).status).toBe(200);
      expect((await history()).bill).toEqual(snapshot);
      expect((await history()).bill_requested).toBe(false);

      const asked = await ask();
      expect(asked.status).toBe(200);
      expect((await ask()).status).toBe(200);
      expect((await history()).bill_requested).toBe(true);
      const blocked = await order(randomUUID());
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).code).toBe('bill_awaiting_payment');

      const picked = await (await sync({}, { bill: snapshot })).json();
      expect(picked.bill_requests.map((row: { pos_table_id: string }) => row.pos_table_id)).toEqual(['26']);
      const rejected = await (await sync({ rejected_bill_requests: ['26'] }, { bill: snapshot })).json();
      expect(rejected.bill_requests).toEqual([]);
      expect((await history()).bill_requested).toBe(false);

      expect((await ask()).status).toBe(200);
      const held = await (await sync({}, { bill: snapshot, awaiting_payment: true })).json();
      expect(held.bill_requests).toEqual([]);
      expect((await sql`SELECT bill_requested_at FROM dining_tables WHERE pos_table_id='26'`)[0].bill_requested_at).toBeNull();
      expect((await history()).bill_requested).toBe(true);
      expect((await sync({}, { bill: null })).status).toBe(200);
      expect((await history()).bill).toBeNull();
      expect((await history()).bill_requested).toBe(false);
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
