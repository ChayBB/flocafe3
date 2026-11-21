import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'branch POS reports feed an owner-only dashboard with targets',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `reports_${randomUUID().replaceAll('-', '')}`;
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
      const south = (await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'Kuk Chim', branch: 'Songkhla' } })).body;
      const pair = async (branchId: string) => {
        const code = await call(`/api/v1/portal/admin/branches/${branchId}/pairing-code`, { session: admin, body: {} });
        return (await call('/api/v1/connectors/pair', { body: { code: code.body.code } })).body.connector_token as string;
      };
      const northPos = await pair(north.branch_id);
      const centralPos = await pair(central.branch_id ?? central.id);
      const southPos = await pair(south.branch_id);
      const invite = async (email: string, tenantId: string) => {
        const reply = await call('/api/v1/portal/admin/users', { session: admin, body: { email, display_name: 'Owner', role: 'owner', tenant_id: tenantId } });
        return /#invite=([A-Za-z0-9_-]+)/.exec(reply.body.invite_url)![1];
      };
      const owner = await accept(await invite('owner@kuknop.test', north.tenant_id), 'owner password 1');
      const rival = await accept(await invite('owner@kukchim.test', south.tenant_id), 'owner password 2');

      const today = new Date().toISOString().slice(0, 10);
      const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      const hours = (hour: number, sales: number, bills: number) =>
        Array.from({ length: 24 }, (_, h) => (h === hour ? { sales, bills } : { sales: 0, bills: 0 }));
      const occupied = (hour: number, minutes: number) => Array.from({ length: 24 }, (_, h) => (h === hour ? minutes : 0));
      const report = (date: string, net: number, extra: Record<string, unknown> = {}) => ({
        v: 1, business_date: date, currency: 'THB', timezone: 'Asia/Bangkok',
        sales: { net, gross: net, refunds: 0, discounts: 0, tax: 0, orders: 10, bills: 10, cancelled_orders: 1, guests: 20, guests_estimated: false },
        cost: { ingredient: net * 0.3, ingredient_coverage: 'known', known_cost_sales: net, labor: 100, labor_hours: 8, labor_complete: true, expenses: [{ name: 'Gas', amount: 50 }] },
        payments: [{ method: 'cash', count: 6, total: net * 0.6 }, { method: 'promptpay', count: 4, total: net * 0.4 }],
        categories: [{ name: 'Food', net: net * 0.7, qty: 7 }, { name: 'Drinks', net: net * 0.3, qty: 3 }],
        items: [{ product_id: 'p1', name: 'Fried rice', qty: 7, net: net * 0.7, image: null }],
        hours: hours(12, net, 10),
        tables: { count: 4, occupied_minutes: occupied(12, 120) },
        kitchen: { timed: 10, wait_minutes: 30, prep_minutes: 120, on_time: 8, on_time_minutes: 20 },
        customers: { members: 50, new_members: 2, member_visits: 4, repeat_members: 1, promo_orders: 2 },
        staff: { on_duty: 2 },
        ...extra,
      });
      const publish = (bearer: string, reports: object[]) => call('/api/v1/connectors/reports', { bearer, body: { reports } });

      expect((await publish('not-a-token', [report(today, 1)])).status).toBe(401);
      expect((await publish(northPos, [report(today, 999)])).body).toEqual({ accepted: 1, rejected: 0 });
      const published = await publish(northPos, [report(today, 1000), report(day(-1), 500), report(day(-8), 800), report('2001-01-01', 5), { ...report(day(-2), 1), v: 2 }]);
      expect(published.body).toEqual({ accepted: 3, rejected: 2 });
      await publish(centralPos, [report(today, 300)]);
      await publish(southPos, [report(today, 7777)]);
      expect((await call('/api/v1/connectors/reports', { bearer: northPos, body: { reports: Array.from({ length: 41 }, () => report(today, 1)) } })).status).toBe(422);

      const query = (from: string, to: string, branch?: string) =>
        `/api/v1/portal/owner/reports?from=${from}&to=${to}${branch ? `&branch=${branch}` : ''}`;
      const allReply = await call(query(day(-1), today), { session: owner });
      if (allReply.status !== 200) throw Error(JSON.stringify(allReply));
      const all = allReply.body;
      expect(all.current.net).toBe(1800);
      expect(all.current.bills).toBe(30);
      expect(all.current.aov).toBe(60);
      expect(all.current.food_cost).toBe(540);
      expect(all.current.labor).toBe(300);
      expect(all.current.expenses).toBe(150);
      expect(all.current.profit).toBe(810);
      expect(all.current.table_utilization).toBe(0.5);
      expect(all.current.on_time_rate).toBe(0.8);
      expect(all.current.cancel_rate).toBeCloseTo(3 / 33, 4);
      expect(all.members).toBe(100);
      expect(all.daily.map((d: any) => d.net)).toEqual([500, 1300]);
      expect(all.previous.net).toBe(0);
      expect(all.categories[0]).toEqual({ name: 'Food', net: 1260, qty: 21 });
      expect(all.payments.map((p: any) => p.method)).toEqual(['cash', 'promptpay']);
      expect(all.hours[12]).toMatchObject({ sales: 1800, bills: 30, utilization: 0.5 });
      expect(all.branches.map((b: any) => [b.name, b.net])).toEqual([['Hat Yai', 1500], ['Central', 300]]);

      const week = (await call(query(day(-6), today, north.branch_id), { session: owner })).body;
      expect(week.current.net).toBe(1500);
      expect(week.previous.net).toBe(800);
      expect(week.range.prev_to).toBe(day(-7));
      expect((await call(query(day(-1), today), { session: rival })).body.current.net).toBe(7777);
      expect((await call(query(day(-1), today, north.branch_id), { session: rival })).status).toBe(404);
      expect((await call(query(day(-1), today), { session: admin })).status).toBe(403);
      expect((await call(query(today, day(-1)), { session: owner })).body.code).toBe('range_invalid');
      expect((await call(query(day(-400), today), { session: owner })).body.code).toBe('range_invalid');

      const month = today.slice(0, 7);
      const target = (session: string, branch: string, value: number | null) =>
        call(`/api/v1/portal/owner/branches/${branch}/target`, { session, body: { month, target: value } });
      expect((await target(rival, north.branch_id, 1)).status).toBe(404);
      expect((await target(owner, north.branch_id, 30000)).status).toBe(200);
      expect((await target(owner, central.branch_id ?? central.id, 10000)).status).toBe(200);
      const monthStart = `${month}-01`;
      const withTarget = (await call(query(monthStart, today), { session: owner })).body;
      expect(withTarget.target.target).toBe(40000);
      const monthNet = [report(today, 0), report(day(-1), 0), report(day(-8), 0)]
        .map((r) => r.business_date).filter((d) => d >= monthStart);
      expect(withTarget.target.achieved).toBe(300 + (monthNet.includes(today) ? 1000 : 0) + (monthNet.includes(day(-1)) ? 500 : 0) + (monthNet.includes(day(-8)) ? 800 : 0));
      expect((await target(owner, north.branch_id, null)).status).toBe(200);
      expect((await call(query(monthStart, today, north.branch_id), { session: owner })).body.target.target).toBeNull();

      const actions = (await call('/api/v1/portal/admin/audit', { session: admin })).body.entries.map((e: any) => e.action);
      expect(actions).toContain('sales_target_set');
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
