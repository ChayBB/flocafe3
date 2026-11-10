import { createHmac } from 'node:crypto';
import { Elysia, t } from 'elysia';
import { constantEqual } from '../../../packages/shared/src/index';

export const tableSessionScope = t.Object({
  tenant_id: t.String({ format: 'uuid' }),
  branch_id: t.String({ format: 'uuid' }),
  table_id: t.String({ format: 'uuid' }),
});

interface MenuPreviewOptions {
  secret: string;
  isAdmin(request: Request): boolean;
  createSession(scope: typeof tableSessionScope.static): Promise<{ id: string; expires_at: Date } | null>;
  readMenu(sessionId: string): Promise<{
    table_name: string;
    items: readonly { name: string; price_satang: number }[];
  } | null>;
}

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

export function menuPreview(options: MenuPreviewOptions) {
  const sign = (sessionId: string) =>
    createHmac('sha256', options.secret)
      .update('qr-saas/menu-preview/v1\0')
      .update(sessionId)
      .digest('base64url');

  return new Elysia({ name: 'qr-saas-menu-preview' })
    .get('/menu-preview', () => new Response(Bun.file(new URL('./menu-preview.html', import.meta.url)), {
      headers: {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    }))
    .get('/menu-preview.js', () => new Response(Bun.file(new URL('./menu-preview.js', import.meta.url)), {
      headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' },
    }))
    .post('/api/v1/admin/table-menu-previews', async ({ request, body }) => {
      if (!options.isAdmin(request)) return json({ error: 'unauthorized' }, 401);
      const session = await options.createSession(body);
      if (!session) return json({ error: 'table not found' }, 404);
      return json({
        expires_at: session.expires_at,
        preview_path: `/menu-preview#${session.id}.${sign(session.id)}`,
      }, 201);
    }, { body: tableSessionScope })
    .get('/api/v1/menu-preview', async ({ request }) => {
      const authorization = request.headers.get('authorization') ?? '';
      const match = /^Bearer ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match || !constantEqual(match[2], sign(match[1])))
        return json({ error: 'invalid preview session' }, 401);
      const menu = await options.readMenu(match[1]);
      return menu ? json(menu) : json({ error: 'invalid preview session' }, 401);
    });
}
