import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'administrators turn Cloud modules off per branch',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `modules_${randomUUID().replaceAll('-', '')}`;
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
      const env = { ...process.env, DATABASE_URL: scoped.href, PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test' };
      const bootstrap = Bun.spawnSync([process.execPath, 'run', 'scripts/create-admin.ts', 'admin@example.test', 'Cloud admin'], { env });
      expect(bootstrap.exitCode).toBe(0);
      const adminInvite = /#invite=([A-Za-z0-9_-]+)/.exec(bootstrap.stdout.toString())![1];

      api = Bun.spawn([process.execPath, 'run', 'apps/api/src/index.ts'], {
        env: { ...env, REDIS_URL: redisUrl!, PORT: '0', ADMIN_BOOTSTRAP_TOKEN: 'fixture-admin-menu-only-0123456789', ALLOW_LEGACY_CONNECTOR_TOKEN: 'false' },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
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
        Bun.sleep(15000).then(() => { throw Error('Cloud API startup timed out'); }),
      ]);
      const base = `http://127.0.0.1:${port}`;
      type Reply = { status: number; body: any; cookie: string | null };
      const call = async (path: string, init: { session?: string; body?: object; header?: boolean; bearer?: string } = {}): Promise<Reply> => {
        const response = await fetch(`${base}${path}`, {
          method: init.body ? 'POST' : 'GET',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.30',
            ...(init.header === false ? {} : { 'x-flo-portal': '1' }),
            ...(init.session ? { cookie: `flo_portal=${init.session}` } : {}),
            ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const text = await response.text();
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not json */ }
        return { status: response.status, body, cookie: response.headers.get('set-cookie') };
      };
      const accept = async (token: string, password: string) =>
        /flo_portal=([^;]*)/.exec((await call('/api/v1/portal/invite/accept', { body: { token, password } })).cookie ?? '')![1];

      const admin = await accept(adminInvite, 'correct horse battery');
      const north = (await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'Kuk Nop', branch: 'Hat Yai' } })).body;
      const central = (await call(`/api/v1/portal/admin/shops/${north.tenant_id}/branches`, { session: admin, body: { name: 'Central' } })).body;
      const pair = async (branchId: string) => {
        const code = await call(`/api/v1/portal/admin/branches/${branchId}/pairing-code`, { session: admin, body: {} });
        return (await call('/api/v1/connectors/pair', { body: { code: code.body.code } })).body.connector_token as string;
      };
      const northPos = await pair(north.branch_id);
      const centralPos = await pair(central.branch_id);
      const inviteReply = await call('/api/v1/portal/admin/users', { session: admin, body: { email: 'owner@kuknop.test', display_name: 'Owner', role: 'owner', tenant_id: north.tenant_id } });
      const owner = await accept(/#invite=([A-Za-z0-9_-]+)/.exec(inviteReply.body.invite_url)![1], 'owner password 1');
      const [tea] = await sql`INSERT INTO menu_items (tenant_id, branch_id, external_id, name, price_satang, pos_product_id)
        VALUES (${north.tenant_id}, ${north.branch_id}, 'p-tea', 'Thai tea', 4500, 'p-tea') RETURNING id`;
      const [table] = await sql`INSERT INTO dining_tables (tenant_id, branch_id, name, pos_table_id, qr_ordering_until, qr_session_generation)
        VALUES (${north.tenant_id}, ${north.branch_id}, 'T1', 'T1', now() + interval '1 hour', gen_random_uuid()) RETURNING qr_public_id`;
      const setModule = (branchId: string, module: string, enabled: boolean, session = admin) =>
        call(`/api/v1/portal/admin/branches/${branchId}/modules`, { session, body: { module, enabled } });
      const modulesOf = async (branchId: string) =>
        (await call('/api/v1/portal/owner/shop', { session: owner })).body.shop.branches.find((b: any) => b.id === branchId).modules;
      const order = (tableToken: string, key: string, quantity = 1) => fetch(`${base}/api/v1/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tableToken}`, 'idempotency-key': key },
        body: JSON.stringify({ items: [{ menu_item_id: tea.id, quantity }] }),
      });
      const report = { v: 1, business_date: new Date().toISOString().slice(0, 10), currency: 'THB', sales: { net: 100, bills: 1 } };
      const today = report.business_date;
      const dashboard = (branch?: string) =>
        call(`/api/v1/portal/owner/reports?from=${today}&to=${today}${branch ? `&branch=${branch}` : ''}`, { session: owner });

      expect(await modulesOf(north.branch_id)).toEqual({ qr_ordering: true, menu_editing: true, reports: true });
      expect((await setModule(north.branch_id, 'reports', false, owner)).status).toBe(403);
      expect((await setModule(north.branch_id, 'payroll', false)).status).toBe(422);
      expect((await call(`/api/v1/portal/admin/branches/${north.branch_id}/modules`, { session: admin, body: { module: 'reports', enabled: false }, header: false })).status).toBe(403);

      const firstSession = await call('/api/v1/table-qr/session', { body: { table_key: table.qr_public_id } });
      expect(firstSession.status).toBe(200);
      expect((await order(firstSession.body.table_token, 'order-before')).status).toBe(200);
      expect((await setModule(north.branch_id, 'qr_ordering', false)).status).toBe(200);
      expect((await modulesOf(north.branch_id)).qr_ordering).toBe(false);
      expect((await call('/api/v1/table-qr/session', { body: { table_key: table.qr_public_id } })).body.code).toBe('qr_ordering_disabled');
      const blocked = await order(firstSession.body.table_token, 'order-after');
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).code).toBe('qr_ordering_disabled');
      expect((await order(firstSession.body.table_token, 'order-before')).status).toBe(200);
      await setModule(north.branch_id, 'qr_ordering', true);
      expect((await order(firstSession.body.table_token, 'order-again')).status).toBe(200);

      await sql`UPDATE menu_items SET price_unit = 'kg' WHERE id = ${tea.id}`;
      const guestMenu = await fetch(`${base}/api/v1/menu`, { headers: { authorization: `Bearer ${firstSession.body.table_token}` } });
      expect((await guestMenu.json()).items.find((item: any) => item.id === tea.id).price_unit).toBe('kg');
      expect((await order(firstSession.body.table_token, 'weighed-two', 2)).status).toBe(400);
      expect((await order(firstSession.body.table_token, 'weighed-one', 1)).status).toBe(200);
      await sql`UPDATE menu_items SET price_unit = NULL WHERE id = ${tea.id}`;

      const menu = `/api/v1/portal/owner/branches/${north.branch_id}/menu`;
      expect((await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 5000 } })).status).toBe(200);
      await setModule(north.branch_id, 'menu_editing', false);
      expect((await call(menu, { session: owner })).body.code).toBe('module_disabled');
      expect((await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 5500 } })).status).toBe(403);
      expect((await call(`${menu}/${tea.id}/image`, { session: owner, body: { data: 'iVBORw0KGgoAAAA=' } })).status).toBe(403);
      expect((await call('/api/v1/connectors/menu-changes', { bearer: northPos })).body.changes).toEqual([]);
      await setModule(north.branch_id, 'menu_editing', true);
      expect((await call('/api/v1/connectors/menu-changes', { bearer: northPos })).body.changes).toHaveLength(1);

      expect((await call('/api/v1/connectors/reports', { bearer: northPos, body: { reports: [report] } })).body.accepted).toBe(1);
      expect((await call('/api/v1/connectors/reports', { bearer: centralPos, body: { reports: [{ ...report, sales: { net: 40, bills: 1 } }] } })).body.accepted).toBe(1);
      expect((await dashboard()).body.current.net).toBe(140);
      await setModule(central.branch_id, 'reports', false);
      const without = (await dashboard()).body;
      expect(without.current.net).toBe(100);
      expect(without.branches.map((b: any) => b.name)).toEqual(['Hat Yai']);
      expect((await dashboard(central.branch_id)).body.code).toBe('module_disabled');
      expect((await call('/api/v1/connectors/reports', { bearer: centralPos, body: { reports: [report] } })).status).toBe(403);
      expect((await call(`/api/v1/portal/owner/branches/${central.branch_id}/target`, { session: owner, body: { month: today.slice(0, 7), target: 1 } })).status).toBe(403);
      expect((await call('/api/v1/connectors/reports', { bearer: northPos, body: { reports: [report] } })).status).toBe(200);

      const actions = (await call('/api/v1/portal/admin/audit', { session: admin })).body.entries.map((e: any) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['module_enabled', 'module_disabled']));
    } finally {
      if (api) {
        api.kill();
        await api.exited;
      }
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    }
  },
  60000,
);
