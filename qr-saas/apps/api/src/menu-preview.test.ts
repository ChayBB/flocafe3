import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { menuPreview } from './menu-preview';

const scope = { tenant_id: randomUUID(), branch_id: randomUUID(), table_id: randomUUID() };
const menu = { table_name: 'โต๊ะทดสอบ', items: [{ name: 'ชาเย็น', price_satang: 4500 }] };

test('only an administrator can issue a read-only preview for a matching table', async () => {
  const id = randomUUID();
  let created = 0;
  let readable = true;
  const app = menuPreview({
    secret: 'fixture-preview-signing-secret',
    isAdmin: (request) => request.headers.get('authorization') === 'Bearer fixture-admin',
    async createSession(input) {
      if (input.table_id !== scope.table_id || input.tenant_id !== scope.tenant_id ||
          input.branch_id !== scope.branch_id) return null;
      created++;
      return { id, expires_at: new Date('2030-01-01') };
    },
    async readMenu(sessionId) {
      return sessionId === id && readable ? menu : null;
    },
  });
  const issue = (authorization: string, body = scope) => app.handle(new Request(
    'http://localhost/api/v1/admin/table-menu-previews',
    { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  ));
  expect((await issue('')).status).toBe(401);
  expect((await issue('Bearer fixture-admin', { ...scope, branch_id: randomUUID() })).status).toBe(404);
  const response = await issue('Bearer fixture-admin');
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(created).toBe(1);
  const issued = await response.json() as { preview_path: string };
  expect(Object.keys(issued).sort()).toEqual(['expires_at', 'preview_path']);
  const url = new URL(issued.preview_path, 'http://localhost');
  expect(url.pathname).toBe('/menu-preview');
  expect(url.search).toBe('');
  const key = url.hash.slice(1);
  const read = (authorization?: string) => app.handle(new Request(
    'http://localhost/api/v1/menu-preview', { headers: authorization ? { authorization } : {} },
  ));
  expect((await read()).status).toBe(401);
  expect((await read(`Bearer ${randomUUID()}${key.slice(36)}`)).status).toBe(401);
  const valid = await read(`Bearer ${key}`);
  expect(valid.status).toBe(200);
  expect(valid.headers.get('cache-control')).toBe('no-store');
  expect(await valid.json()).toEqual(menu);
  readable = false;
  expect((await read(`Bearer ${key}`)).status).toBe(401);
  expect((await app.handle(new Request('http://localhost/api/v1/orders', { method: 'POST' }))).status).toBe(404);
});

test('the mobile page serves same-origin assets with a restrictive browser policy', async () => {
  const app = menuPreview({
    secret: 'fixture-preview-signing-secret',
    isAdmin: () => false,
    createSession: async () => null,
    readMenu: async () => null,
  });
  const html = await app.handle(new Request('http://localhost/menu-preview'));
  expect(html.status).toBe(200);
  expect(html.headers.get('content-security-policy')).toContain("form-action 'none'");
  expect(html.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await html.text()).toContain('src="/menu-preview.js"');
  const script = await app.handle(new Request('http://localhost/menu-preview.js'));
  expect(script.status).toBe(200);
  const text = await script.text();
  expect(text).toContain("fetch('/api/v1/menu-preview'");
  expect(text).not.toContain('/api/v1/orders');
});
