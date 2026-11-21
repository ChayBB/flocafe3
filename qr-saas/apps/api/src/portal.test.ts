import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'administrators run shops and owners see only their own shop',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `portal_${randomUUID().replaceAll('-', '')}`;
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
      const bootstrap = Bun.spawnSync([process.execPath, 'run', 'scripts/create-admin.ts', 'Admin@Example.test', 'Cloud admin'], { env });
      expect(bootstrap.exitCode).toBe(0);
      const adminInvite = /#invite=([A-Za-z0-9_-]+)/.exec(bootstrap.stdout.toString())![1];
      expect(bootstrap.stdout.toString()).toContain('https://portal.example.test/admin/login#invite=');

      api = Bun.spawn([process.execPath, 'run', 'apps/api/src/index.ts'], {
        env: { ...env, REDIS_URL: redisUrl!, PORT: '0', ADMIN_BOOTSTRAP_TOKEN: 'fixture-admin-portal-only-0123456789', ALLOW_LEGACY_CONNECTOR_TOKEN: 'false' },
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
      const call = async (path: string, init: { session?: string; body?: object; header?: boolean; client?: string; bearer?: string } = {}): Promise<Reply> => {
        const response = await fetch(`${base}${path}`, {
          method: init.body ? 'POST' : 'GET',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': init.client ?? '203.0.113.20',
            ...(init.header === false ? {} : { 'x-flo-portal': '1' }),
            ...(init.session ? { cookie: `flo_portal=${init.session}` } : {}),
            ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const text = await response.text();
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* html or script */ }
        return { status: response.status, body, cookie: response.headers.get('set-cookie') };
      };
      const sessionOf = (reply: Reply) => /flo_portal=([^;]*)/.exec(reply.cookie ?? '')![1];

      const legacy = await fetch(`${base}/portal/`, { redirect: 'manual' });
      expect(legacy.status).toBe(301);
      expect(legacy.headers.get('location')).toBe('/admin/login');
      const page = await fetch(`${base}/admin/login`);
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await page.text()).toContain('/portal/app.js');
      expect((await fetch(`${base}/portal/app.js`)).status).toBe(200);
      const customerLogin = await fetch(`${base}/customer/login`);
      expect(customerLogin.status).toBe(200);
      expect(customerLogin.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await customerLogin.text()).toContain('/portal/app.js');

      expect((await call('/api/v1/portal/invite/accept', { body: { token: adminInvite, password: 'short' } })).body.code).toBe('password_too_short');
      expect((await call('/api/v1/portal/invite/accept', { body: { token: adminInvite, password: 'correct horse battery' }, header: false })).status).toBe(403);
      const accepted = await call('/api/v1/portal/invite/accept', { body: { token: adminInvite, password: 'correct horse battery' } });
      expect(accepted.status).toBe(200);
      expect(accepted.cookie).toContain('HttpOnly; Secure; SameSite=Strict');
      expect((await call('/api/v1/portal/invite/accept', { body: { token: adminInvite, password: 'correct horse battery' } })).status).toBe(404);

      expect((await call('/api/v1/portal/login', { body: { email: 'admin@example.test', password: 'wrong password!' } })).status).toBe(401);
      const login = await call('/api/v1/portal/login', { body: { email: 'ADMIN@example.test', password: 'correct horse battery' } });
      expect(login.status).toBe(200);
      const admin = sessionOf(login);
      expect((await call('/api/v1/portal/me', { session: admin })).body.user.role).toBe('admin');

      const north = (await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'Kuk Nop', branch: 'Hat Yai' } })).body;
      const south = (await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'Kuk Chim', branch: 'Songkhla' } })).body;
      expect((await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'kuk nop', branch: 'X' } })).status).toBe(409);
      expect((await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'No header', branch: 'X' }, header: false })).status).toBe(403);
      const second = await call(`/api/v1/portal/admin/shops/${north.tenant_id}/branches`, { session: admin, body: { name: 'Central' } });
      expect(second.status).toBe(200);

      const code = await call(`/api/v1/portal/admin/branches/${north.branch_id}/pairing-code`, { session: admin, body: {} });
      expect(code.body.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
      const paired = await call('/api/v1/connectors/pair', { body: { code: code.body.code } });
      expect(paired.status).toBe(200);
      const before = (await call('/api/v1/portal/admin/shops', { session: admin })).body.shops;
      const hatYai = before.find((s: any) => s.id === north.tenant_id).branches.find((b: any) => b.id === north.branch_id);
      expect(hatYai.pos.last_seen_at).toBeNull();
      expect((await call('/api/v1/connectors/catalog', { bearer: paired.body.connector_token })).status).toBe(200);
      await Bun.sleep(200);
      const seen = (await call('/api/v1/portal/admin/shops', { session: admin })).body.shops
        .find((s: any) => s.id === north.tenant_id).branches.find((b: any) => b.id === north.branch_id);
      expect(seen.pos.last_seen_at).not.toBeNull();

      const invited = await call('/api/v1/portal/admin/users', { session: admin, body: { email: 'owner@kuknop.test', display_name: 'Nop', role: 'owner', tenant_id: north.tenant_id } });
      expect(invited.status).toBe(200);
      expect((await call('/api/v1/portal/admin/users', { session: admin, body: { email: 'owner@kuknop.test', display_name: 'Nop', role: 'owner', tenant_id: north.tenant_id } })).status).toBe(409);
      expect((await call('/api/v1/portal/admin/users', { session: admin, body: { email: 'x@y.test', display_name: 'X', role: 'owner' } })).body.code).toBe('shop_required');
      expect(invited.body.invite_url).toContain('/customer/login#invite=');
      const ownerToken = /#invite=([A-Za-z0-9_-]+)/.exec(invited.body.invite_url)![1];
      const owner = sessionOf(await call('/api/v1/portal/invite/accept', { body: { token: ownerToken, password: 'owner password 1' } }));
      const own = await call('/api/v1/portal/owner/shop', { session: owner });
      expect(own.body.shop.name).toBe('Kuk Nop');
      expect(own.body.shop.branches.map((b: any) => b.name)).toEqual(['Hat Yai', 'Central']);
      expect((await call('/api/v1/portal/admin/shops', { session: owner })).status).toBe(403);
      expect((await call(`/api/v1/portal/admin/branches/${south.branch_id}/pairing-code`, { session: owner, body: {} })).status).toBe(403);
      expect((await call('/api/v1/portal/owner/shop', { session: admin })).status).toBe(403);

      expect((await call(`/api/v1/portal/admin/branches/${north.branch_id}/revoke-pos`, { session: admin, body: {} })).status).toBe(200);
      expect((await call('/api/v1/connectors/catalog', { bearer: paired.body.connector_token })).status).toBe(401);
      expect((await call(`/api/v1/portal/admin/branches/${north.branch_id}/revoke-pos`, { session: admin, body: {} })).body.code).toBe('pos_not_paired');

      const ownerId = invited.body.user_id;
      const setName = (username: string, session = admin) =>
        call(`/api/v1/portal/admin/users/${ownerId}/username`, { session, body: { username } });
      expect((await setName('no')).body.code).toBe('username_invalid');
      expect((await setName('nop@shop')).body.code).toBe('username_invalid');
      expect((await setName('kuknop', owner)).status).toBe(403);
      expect((await setName('KukNop')).status).toBe(200);
      const listed = (await call('/api/v1/portal/admin/users', { session: admin })).body.users;
      expect(listed.find((u: any) => u.id === ownerId).username).toBe('kuknop');
      expect((await call('/api/v1/portal/admin/users', { session: admin, body: { email: 'twin@kuknop.test', username: 'kuknop', display_name: 'Twin', role: 'owner', tenant_id: north.tenant_id } })).body.code).toBe('username_exists');
      const byName = await call('/api/v1/portal/login', { body: { email: 'KUKNOP', password: 'owner password 1' } });
      expect(byName.status).toBe(200);
      expect(byName.body.user.id).toBe(ownerId);
      expect((await call('/api/v1/portal/login', { body: { email: 'kuknop', password: 'wrong password' } })).status).toBe(401);
      expect((await setName('')).status).toBe(200);
      expect((await call('/api/v1/portal/login', { body: { email: 'kuknop', password: 'owner password 1' } })).status).toBe(401);
      expect((await call(`/api/v1/portal/admin/users/${ownerId}/disabled`, { session: admin, body: { disabled: true } })).status).toBe(200);
      expect((await call('/api/v1/portal/owner/shop', { session: owner })).status).toBe(401);
      expect((await call('/api/v1/portal/login', { body: { email: 'owner@kuknop.test', password: 'owner password 1' } })).status).toBe(401);
      const adminId = (await call('/api/v1/portal/me', { session: admin })).body.user.id;
      expect((await call(`/api/v1/portal/admin/users/${adminId}/disabled`, { session: admin, body: { disabled: true } })).body.code).toBe('cannot_disable_self');

      const actions = (await call('/api/v1/portal/admin/audit', { session: admin })).body.entries.map((e: any) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['shop_created', 'branch_created', 'pairing_code_issued', 'user_invited', 'pos_revoked', 'user_disabled']));

      for (let attempt = 0; attempt < 8; attempt += 1)
        await call('/api/v1/portal/login', { body: { email: 'admin@example.test', password: 'guess guess' }, client: `198.51.100.${attempt}` });
      expect((await call('/api/v1/portal/login', { body: { email: 'admin@example.test', password: 'correct horse battery' }, client: '198.51.100.99' })).status).toBe(429);

      expect((await call('/api/v1/portal/logout', { session: admin, body: {} })).cookie).toContain('Max-Age=0');
      expect((await call('/api/v1/portal/me', { session: admin })).status).toBe(401);
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
