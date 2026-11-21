import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test.skipIf(!databaseUrl || !redisUrl)(
  'owners change prices and photos that the branch POS applies or rejects',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `menu_${randomUUID().replaceAll('-', '')}`;
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
      const south = (await call('/api/v1/portal/admin/shops', { session: admin, body: { shop: 'Kuk Chim', branch: 'Songkhla' } })).body;
      const pair = async (branchId: string) => {
        const code = await call(`/api/v1/portal/admin/branches/${branchId}/pairing-code`, { session: admin, body: {} });
        return (await call('/api/v1/connectors/pair', { body: { code: code.body.code } })).body.connector_token as string;
      };
      const northPos = await pair(north.branch_id);
      const southPos = await pair(south.branch_id);
      const [tea] = await sql`INSERT INTO menu_items (tenant_id, branch_id, external_id, name, price_satang, pos_product_id)
        VALUES (${north.tenant_id}, ${north.branch_id}, 'p-tea', 'Thai tea', 4500, 'p-tea') RETURNING id`;
      const [rice] = await sql`INSERT INTO menu_items (tenant_id, branch_id, external_id, name, price_satang, pos_product_id, pos_variant_id)
        VALUES (${north.tenant_id}, ${north.branch_id}, 'variant:v-large', 'Fried rice Large', 7000, 'p-rice', 'v-large') RETURNING id`;
      const [other] = await sql`INSERT INTO menu_items (tenant_id, branch_id, external_id, name, price_satang, pos_product_id)
        VALUES (${south.tenant_id}, ${south.branch_id}, 'p-x', 'Other shop', 100, 'p-x') RETURNING id`;
      const invite = async (email: string, tenantId: string) => {
        const reply = await call('/api/v1/portal/admin/users', { session: admin, body: { email, display_name: 'Owner', role: 'owner', tenant_id: tenantId } });
        return /#invite=([A-Za-z0-9_-]+)/.exec(reply.body.invite_url)![1];
      };
      const owner = await accept(await invite('owner@kuknop.test', north.tenant_id), 'owner password 1');
      const rival = await accept(await invite('owner@kukchim.test', south.tenant_id), 'owner password 2');
      const menu = `/api/v1/portal/owner/branches/${north.branch_id}/menu`;

      expect((await call(menu, { session: owner })).body.items.map((i: any) => i.name)).toEqual(['Fried rice Large', 'Thai tea']);
      expect((await call(menu, { session: rival })).status).toBe(404);
      expect((await call(menu, { session: admin })).status).toBe(403);
      expect((await call(`${menu}/${tea.id}/price`, { session: rival, body: { price_satang: 1 } })).status).toBe(404);
      expect((await call(`/api/v1/portal/owner/branches/${south.branch_id}/menu/${tea.id}/price`, { session: rival, body: { price_satang: 1 } })).body.code).toBe('item_not_found');
      expect((await call(`${menu}/${other.id}/price`, { session: owner, body: { price_satang: 1 } })).status).toBe(404);
      expect((await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 5000 }, header: false })).status).toBe(403);
      expect((await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: -1 } })).status).toBe(422);

      expect((await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 4500 } })).body.unchanged).toBe(true);
      const first = (await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 4800 } })).body.id;
      const price = (await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 5000 } })).body.id;
      const variantPrice = (await call(`${menu}/${rice.id}/price`, { session: owner, body: { price_satang: 7500 } })).body.id;
      const photo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('owner photo')]);
      expect((await call(`${menu}/${tea.id}/image`, { session: owner, body: { data: Buffer.from('GIF89a-not-allowed').toString('base64') } })).body.code).toBe('image_invalid');
      const image = (await call(`${menu}/${tea.id}/image`, { session: owner, body: { data: photo.toString('base64') } })).body.id;
      const listed = (await call(menu, { session: owner })).body.changes;
      expect(listed.map((c: any) => c.id).sort()).toEqual([price, variantPrice, image].sort());
      expect(listed.some((c: any) => c.id === first)).toBe(false);

      expect((await call('/api/v1/connectors/menu-changes', { bearer: southPos })).body.changes).toEqual([]);
      const pulled = (await call('/api/v1/connectors/menu-changes', { bearer: northPos })).body.changes;
      expect(pulled.map((c: any) => c.id)).toEqual([price, variantPrice, image]);
      expect(pulled[0]).toMatchObject({ pos_product_id: 'p-tea', pos_variant_id: null, field: 'price', base_value: '4500', new_value: '5000', force: false, image_data: null });
      expect(pulled[1]).toMatchObject({ pos_product_id: 'p-rice', pos_variant_id: 'v-large' });
      expect(Buffer.from(pulled[2].image_data, 'base64').equals(photo)).toBe(true);
      expect(pulled[2].new_value).toMatch(/^[a-f0-9]{64}\.png$/);
      expect((await call('/api/v1/connectors/menu-changes')).status).toBe(401);

      const report = (id: string, bearer: string, body: object) => call(`/api/v1/connectors/menu-changes/${id}/result`, { bearer, body });
      expect((await report(price, southPos, { outcome: 'applied' })).status).toBe(404);
      expect((await report(price, northPos, { outcome: 'conflict', pos_value: '5200' })).status).toBe(200);
      expect((await report(price, northPos, { outcome: 'applied' })).status).toBe(404);
      expect((await call(menu, { session: owner })).body.changes.find((c: any) => c.id === price)).toMatchObject({ status: 'conflict', pos_value: '5200' });
      expect((await call(`/api/v1/portal/owner/changes/${price}/resolve`, { session: rival, body: { keep: 'web' } })).status).toBe(404);
      expect((await call(`/api/v1/portal/owner/changes/${price}/resolve`, { session: owner, body: { keep: 'web' } })).status).toBe(200);
      const forced = (await call('/api/v1/connectors/menu-changes', { bearer: northPos })).body.changes.find((c: any) => c.id === price);
      expect(forced.force).toBe(true);
      expect((await report(price, northPos, { outcome: 'applied' })).status).toBe(200);
      expect((await report(variantPrice, northPos, { outcome: 'applied' })).status).toBe(200);
      expect((await report(image, northPos, { outcome: 'applied' })).status).toBe(200);
      const items = (await call(menu, { session: owner })).body.items;
      expect(items.find((i: any) => i.id === tea.id)).toMatchObject({ price_satang: 5000, image: pulled[2].new_value });
      expect(items.find((i: any) => i.id === rice.id).price_satang).toBe(7500);

      const stale = (await call(`${menu}/${tea.id}/price`, { session: owner, body: { price_satang: 5500 } })).body.id;
      await report(stale, northPos, { outcome: 'conflict', pos_value: '5100' });
      expect((await call(`/api/v1/portal/owner/changes/${stale}/resolve`, { session: owner, body: { keep: 'pos' } })).status).toBe(200);
      const dropped = (await call(`${menu}/${rice.id}/price`, { session: owner, body: { price_satang: 9900 } })).body.id;
      expect((await call(`/api/v1/portal/owner/changes/${dropped}/cancel`, { session: rival, body: {} })).status).toBe(404);
      expect((await call(`/api/v1/portal/owner/changes/${dropped}/cancel`, { session: owner, body: {} })).status).toBe(200);
      expect((await call('/api/v1/connectors/menu-changes', { bearer: northPos })).body.changes).toEqual([]);
      const statuses = Object.fromEntries((await call(menu, { session: owner })).body.changes.map((c: any) => [c.id, c.status]));
      expect(statuses).toMatchObject({ [price]: 'applied', [image]: 'applied', [stale]: 'kept_pos', [dropped]: 'cancelled' });

      const actions = (await call('/api/v1/portal/admin/audit', { session: admin })).body.entries.map((e: any) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['menu_price_requested', 'menu_image_requested', 'menu_conflict_keep_web', 'menu_conflict_keep_pos', 'menu_change_cancelled']));
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
