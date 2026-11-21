import { MODULES, moduleEnabled, modulesJson, setModule } from './modules';
import { MAX_REPORT_DAYS, ownerDashboard, setSalesTarget } from './reports';
import { Elysia, t } from 'elysia';
import type { Sql } from 'postgres';
import { revokeInstallation } from './connector-auth';
import { attemptLimiter, createPairingCode } from './pairing';
import {
  acceptInvite,
  audit,
  createInvite,
  createSession,
  endSession,
  MIN_PASSWORD_LENGTH,
  PORTAL_HEADER,
  type PortalUser,
  SESSION_HOURS,
  sessionCookie,
  sessionUser,
  verifyLogin,
} from './portal-auth';
import { portalAssets } from './portal-ui/assets';
import { branchMenu, cancelChange, MAX_PRICE_SATANG, ownerImage, requestMenuChange, resolveConflict } from './menu-changes';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status: number, code: string) => json({ code }, status);
const Uuid = t.String({ format: 'uuid' });
const ReportDate = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Name = t.String({ minLength: 1, maxLength: 100 });

function clientOf(request: Request, server: { requestIP(r: Request): { address: string } | null } | null) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || server?.requestIP(request)?.address || 'unknown';
}

/** Shops with their branches and each branch's POS link, newest shop first. */
async function listShops(sql: Sql, tenantId: string | null) {
  return sql`
    SELECT t.id, t.name, t.created_at,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', b.id, 'name', b.name, 'created_at', b.created_at,
          'pos', (SELECT jsonb_build_object('label', c.label, 'paired_at', c.created_at, 'last_seen_at', c.last_seen_at)
                  FROM connector_installations c
                  WHERE c.tenant_id = b.tenant_id AND c.branch_id = b.id AND c.revoked_at IS NULL),
          'code_expires_at', (SELECT max(p.expires_at) FROM connector_pairing_codes p
                  WHERE p.tenant_id = b.tenant_id AND p.branch_id = b.id AND p.used_at IS NULL AND p.expires_at > now()),
          'modules', ${modulesJson(sql)}
        ) ORDER BY b.created_at)
        FROM branches b WHERE b.tenant_id = t.id
      ), '[]'::jsonb) AS branches
    FROM tenants t
    WHERE ${tenantId}::uuid IS NULL OR t.id = ${tenantId}
    ORDER BY t.created_at DESC`;
}

export function portal(options: { sql: Sql; publicOrigin: string }) {
  const { sql, publicOrigin } = options;
  const loginByClient = attemptLimiter(20, 15 * 60_000);
  const loginByEmail = attemptLimiter(8, 15 * 60_000);
  const inviteByClient = attemptLimiter(20, 15 * 60_000);

  const guard = async (request: Request, role?: 'admin' | 'owner'): Promise<PortalUser | Response> => {
    if (request.method !== 'GET' && request.headers.get(PORTAL_HEADER) !== '1') return fail(403, 'portal_header_required');
    const user = await sessionUser(sql, request);
    if (!user) return fail(401, 'signed_out');
    if (role && user.role !== role) return fail(403, 'forbidden');
    return user;
  };
  const signIn = async (user: PortalUser) =>
    json({ user }, 200, { 'set-cookie': sessionCookie(await createSession(sql, user.id), SESSION_HOURS * 3600) });
  const branchOf = async (branchId: string) =>
    (await sql`SELECT tenant_id, id, name FROM branches WHERE id = ${branchId}`)[0] as
      { tenant_id: string; id: string; name: string } | undefined;

  return new Elysia()
    .use(portalAssets())
    .post('/api/v1/portal/login', async ({ request, body, server }) => {
      if (request.headers.get(PORTAL_HEADER) !== '1') return fail(403, 'portal_header_required');
      const email = body.email.trim().toLowerCase();
      if (!loginByClient.allow(clientOf(request, server)) || !loginByEmail.allow(email)) return fail(429, 'too_many_attempts');
      const user = await verifyLogin(sql, email, body.password);
      if (!user) return fail(401, 'invalid_credentials');
      await audit(sql, { userId: user.id, action: 'login', tenantId: user.tenant_id });
      return signIn(user);
    }, { body: t.Object({ email: t.String({ minLength: 3, maxLength: 200 }), password: t.String({ minLength: 1, maxLength: 200 }) }) })
    .post('/api/v1/portal/logout', async ({ request }) => {
      if (request.headers.get(PORTAL_HEADER) !== '1') return fail(403, 'portal_header_required');
      await endSession(sql, request);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    })
    .post('/api/v1/portal/invite/accept', async ({ request, body, server }) => {
      if (request.headers.get(PORTAL_HEADER) !== '1') return fail(403, 'portal_header_required');
      if (!inviteByClient.allow(clientOf(request, server))) return fail(429, 'too_many_attempts');
      if (body.password.length < MIN_PASSWORD_LENGTH) return fail(400, 'password_too_short');
      const user = await acceptInvite(sql, body.token, body.password);
      if (!user) return fail(404, 'invite_invalid');
      await audit(sql, { userId: user.id, action: 'password_set', tenantId: user.tenant_id });
      return signIn(user);
    }, { body: t.Object({ token: t.String({ minLength: 20, maxLength: 100 }), password: t.String({ minLength: 1, maxLength: 200 }) }) })
    .get('/api/v1/portal/me', async ({ request }) => {
      const user = await guard(request);
      return user instanceof Response ? user : json({ user });
    })

    .get('/api/v1/portal/admin/shops', async ({ request }) => {
      const user = await guard(request, 'admin');
      return user instanceof Response ? user : json({ shops: await listShops(sql, null) });
    })
    .post('/api/v1/portal/admin/shops', async ({ request, body }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const shop = body.shop.trim();
      const created = await sql.begin(async (tx) => {
        const [duplicate] = await tx`SELECT id FROM tenants WHERE lower(name) = lower(${shop})`;
        if (duplicate) return null;
        const [tenant] = await tx`INSERT INTO tenants(name) VALUES (${shop}) RETURNING id`;
        const [branch] = await tx`INSERT INTO branches(tenant_id, name) VALUES (${tenant.id}, ${body.branch.trim()}) RETURNING id`;
        return { tenant_id: tenant.id as string, branch_id: branch.id as string };
      });
      if (!created) return fail(409, 'shop_exists');
      await audit(sql, { userId: user.id, action: 'shop_created', tenantId: created.tenant_id, branchId: created.branch_id, detail: { shop, branch: body.branch.trim() } });
      return json(created);
    }, { body: t.Object({ shop: Name, branch: Name }) })
    .post('/api/v1/portal/admin/shops/:tenantId/branches', async ({ request, params, body }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const [tenant] = await sql`SELECT id FROM tenants WHERE id = ${params.tenantId}`;
      if (!tenant) return fail(404, 'shop_not_found');
      const [branch] = await sql`INSERT INTO branches(tenant_id, name) VALUES (${params.tenantId}, ${body.name.trim()}) RETURNING id`;
      await audit(sql, { userId: user.id, action: 'branch_created', tenantId: params.tenantId, branchId: branch.id, detail: { branch: body.name.trim() } });
      return json({ branch_id: branch.id });
    }, { params: t.Object({ tenantId: Uuid }), body: t.Object({ name: Name }) })
    .post('/api/v1/portal/admin/branches/:branchId/pairing-code', async ({ request, params }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch) return fail(404, 'branch_not_found');
      const issued = await createPairingCode(sql, { tenantId: branch.tenant_id, branchId: branch.id, label: `${branch.name} POS` });
      await audit(sql, { userId: user.id, action: 'pairing_code_issued', tenantId: branch.tenant_id, branchId: branch.id });
      return json(issued);
    }, { params: t.Object({ branchId: Uuid }) })
    .post('/api/v1/portal/admin/branches/:branchId/revoke-pos', async ({ request, params }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch) return fail(404, 'branch_not_found');
      const revoked = await revokeInstallation(sql, { tenantId: branch.tenant_id, branchId: branch.id });
      if (!revoked) return fail(404, 'pos_not_paired');
      await audit(sql, { userId: user.id, action: 'pos_revoked', tenantId: branch.tenant_id, branchId: branch.id });
      return json({ ok: true });
    }, { params: t.Object({ branchId: Uuid }) })
    .get('/api/v1/portal/admin/users', async ({ request }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const users = await sql`
        SELECT u.id, u.email, u.display_name, u.role, u.tenant_id, t.name AS shop,
               u.password_hash IS NOT NULL AS active, u.disabled_at, u.created_at
        FROM portal_users u LEFT JOIN tenants t ON t.id = u.tenant_id
        ORDER BY u.role, t.name NULLS FIRST, u.email`;
      return json({ users });
    })
    .post('/api/v1/portal/admin/users', async ({ request, body }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const tenantId = body.role === 'owner' ? body.tenant_id ?? null : null;
      if (body.role === 'owner' && !tenantId) return fail(400, 'shop_required');
      const email = body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'email_invalid');
      const created = await sql`
        INSERT INTO portal_users(email, display_name, role, tenant_id)
        VALUES (${email}, ${body.display_name.trim()}, ${body.role}, ${tenantId})
        ON CONFLICT DO NOTHING RETURNING id`.catch((error) => {
        if ((error as { code?: string }).code === '23503') return null;
        throw error;
      });
      if (created === null) return fail(404, 'shop_not_found');
      if (!created.length) return fail(409, 'email_exists');
      const inviteUrl = await createInvite(sql, created[0].id, publicOrigin, body.role);
      await audit(sql, { userId: user.id, action: 'user_invited', tenantId, detail: { email, role: body.role } });
      return json({ user_id: created[0].id, invite_url: inviteUrl });
    }, { body: t.Object({
      email: t.String({ minLength: 3, maxLength: 200 }),
      display_name: Name,
      role: t.Union([t.Literal('admin'), t.Literal('owner')]),
      tenant_id: t.Optional(Uuid),
    }) })
    .post('/api/v1/portal/admin/users/:userId/invite', async ({ request, params }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const [target] = await sql`SELECT id, tenant_id, email, role FROM portal_users WHERE id = ${params.userId} AND disabled_at IS NULL`;
      if (!target) return fail(404, 'user_not_found');
      const inviteUrl = await createInvite(sql, target.id, publicOrigin, target.role);
      await audit(sql, { userId: user.id, action: 'user_reinvited', tenantId: target.tenant_id, detail: { email: target.email } });
      return json({ invite_url: inviteUrl });
    }, { params: t.Object({ userId: Uuid }) })
    .post('/api/v1/portal/admin/users/:userId/disabled', async ({ request, params, body }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      if (params.userId === user.id) return fail(409, 'cannot_disable_self');
      const [target] = await sql`
        UPDATE portal_users SET disabled_at = ${body.disabled ? sql`now()` : null}
        WHERE id = ${params.userId} RETURNING id, tenant_id, email`;
      if (!target) return fail(404, 'user_not_found');
      if (body.disabled) await sql`DELETE FROM portal_sessions WHERE user_id = ${target.id}`;
      await audit(sql, { userId: user.id, action: body.disabled ? 'user_disabled' : 'user_enabled', tenantId: target.tenant_id, detail: { email: target.email } });
      return json({ ok: true });
    }, { params: t.Object({ userId: Uuid }), body: t.Object({ disabled: t.Boolean() }) })
    .get('/api/v1/portal/admin/audit', async ({ request }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const entries = await sql`
        SELECT a.created_at, a.action, a.detail, u.email AS actor, t.name AS shop, b.name AS branch
        FROM portal_audit a
        LEFT JOIN portal_users u ON u.id = a.user_id
        LEFT JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN branches b ON b.id = a.branch_id
        ORDER BY a.id DESC LIMIT 200`;
      return json({ entries });
    })

    .post('/api/v1/portal/admin/branches/:branchId/modules', async ({ request, params, body }) => {
      const user = await guard(request, 'admin');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch) return fail(404, 'branch_not_found');
      await setModule(sql, branch.tenant_id, branch.id, body.module, body.enabled);
      await audit(sql, { userId: user.id, action: body.enabled ? 'module_enabled' : 'module_disabled', tenantId: branch.tenant_id, branchId: branch.id, detail: { module: body.module } });
      return json({ ok: true });
    }, {
      params: t.Object({ branchId: Uuid }),
      body: t.Object({ module: t.Union(MODULES.map((m) => t.Literal(m))), enabled: t.Boolean() }),
    })
    .get('/api/v1/portal/owner/shop', async ({ request }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const [shop] = await listShops(sql, user.tenant_id);
      return shop ? json({ shop }) : fail(404, 'shop_not_found');
    })
    .get('/api/v1/portal/owner/reports', async ({ request, query }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1;
      if (!(days >= 1 && days <= MAX_REPORT_DAYS)) return fail(400, 'range_invalid');
      if (query.branch) {
        const branch = await branchOf(query.branch);
        if (!branch || branch.tenant_id !== user.tenant_id) return fail(404, 'branch_not_found');
        if (!(await moduleEnabled(sql, branch.tenant_id, branch.id, 'reports'))) return fail(403, 'module_disabled');
      }
      return json(await ownerDashboard(sql, user.tenant_id!, { from: query.from, to: query.to, branchId: query.branch ?? null }));
    }, { query: t.Object({ from: ReportDate, to: ReportDate, branch: t.Optional(Uuid) }) })
    .post('/api/v1/portal/owner/branches/:branchId/target', async ({ request, params, body }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch || branch.tenant_id !== user.tenant_id) return fail(404, 'branch_not_found');
      if (!(await moduleEnabled(sql, branch.tenant_id, branch.id, 'reports'))) return fail(403, 'module_disabled');
      await setSalesTarget(sql, branch.tenant_id, branch.id, body.month, body.target);
      await audit(sql, { userId: user.id, action: 'sales_target_set', tenantId: branch.tenant_id, branchId: branch.id, detail: { month: body.month, target: body.target } });
      return json({ ok: true });
    }, {
      params: t.Object({ branchId: Uuid }),
      body: t.Object({ month: t.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }), target: t.Union([t.Null(), t.Number({ minimum: 0, maximum: 1_000_000_000 })]) }),
    })
    .get('/api/v1/portal/owner/branches/:branchId/menu', async ({ request, params }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch || branch.tenant_id !== user.tenant_id) return fail(404, 'branch_not_found');
      if (!(await moduleEnabled(sql, branch.tenant_id, branch.id, 'menu_editing'))) return fail(403, 'module_disabled');
      return json(await branchMenu(sql, branch.tenant_id, branch.id));
    }, { params: t.Object({ branchId: Uuid }) })
    .post('/api/v1/portal/owner/branches/:branchId/menu/:itemId/price', async ({ request, params, body }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch || branch.tenant_id !== user.tenant_id) return fail(404, 'branch_not_found');
      if (!(await moduleEnabled(sql, branch.tenant_id, branch.id, 'menu_editing'))) return fail(403, 'module_disabled');
      const result = await requestMenuChange(sql, { tenantId: branch.tenant_id, branchId: branch.id, userId: user.id },
        params.itemId, { field: 'price', value: String(body.price_satang) });
      if (!result) return fail(404, 'item_not_found');
      if ('id' in result) await audit(sql, { userId: user.id, action: 'menu_price_requested', tenantId: branch.tenant_id, branchId: branch.id, detail: { item: params.itemId, price_satang: body.price_satang } });
      return json(result);
    }, { params: t.Object({ branchId: Uuid, itemId: Uuid }), body: t.Object({ price_satang: t.Integer({ minimum: 0, maximum: MAX_PRICE_SATANG }) }) })
    .post('/api/v1/portal/owner/branches/:branchId/menu/:itemId/image', async ({ request, params, body }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const branch = await branchOf(params.branchId);
      if (!branch || branch.tenant_id !== user.tenant_id) return fail(404, 'branch_not_found');
      if (!(await moduleEnabled(sql, branch.tenant_id, branch.id, 'menu_editing'))) return fail(403, 'module_disabled');
      const image = ownerImage(body.data);
      if (!image) return fail(400, 'image_invalid');
      const result = await requestMenuChange(sql, { tenantId: branch.tenant_id, branchId: branch.id, userId: user.id },
        params.itemId, { field: 'image', value: image.name }, image);
      if (!result) return fail(404, 'item_not_found');
      if ('id' in result) await audit(sql, { userId: user.id, action: 'menu_image_requested', tenantId: branch.tenant_id, branchId: branch.id, detail: { item: params.itemId, image: image.name } });
      return json(result);
    }, { params: t.Object({ branchId: Uuid, itemId: Uuid }), body: t.Object({ data: t.String({ minLength: 8, maxLength: 140_000 }) }) })
    .post('/api/v1/portal/owner/changes/:changeId/resolve', async ({ request, params, body }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const row = await resolveConflict(sql, user.tenant_id!, params.changeId, body.keep);
      if (!row) return fail(404, 'change_not_found');
      await audit(sql, { userId: user.id, action: body.keep === 'web' ? 'menu_conflict_keep_web' : 'menu_conflict_keep_pos', tenantId: user.tenant_id, branchId: row.branch_id, detail: { change: params.changeId } });
      return json({ ok: true });
    }, { params: t.Object({ changeId: Uuid }), body: t.Object({ keep: t.Union([t.Literal('web'), t.Literal('pos')]) }) })
    .post('/api/v1/portal/owner/changes/:changeId/cancel', async ({ request, params }) => {
      const user = await guard(request, 'owner');
      if (user instanceof Response) return user;
      const row = await cancelChange(sql, user.tenant_id!, params.changeId);
      if (!row) return fail(404, 'change_not_found');
      await audit(sql, { userId: user.id, action: 'menu_change_cancelled', tenantId: user.tenant_id, branchId: row.branch_id, detail: { change: params.changeId } });
      return json({ ok: true });
    }, { params: t.Object({ changeId: Uuid }) });
}
