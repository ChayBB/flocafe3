import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sha256 } from '../../../packages/shared/src/index';
import { posTableQr } from './pos-table-qr';

const testUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;

test.skipIf(!testUrl)('POS stickers retain their table key and require an open table', async () => {
  const url = new URL(testUrl!);
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) throw Error('Use a loopback test database');
  const sql = postgres(testUrl!, { max: 1 });
  const tenantId = randomUUID();
  const branchId = randomUUID();
  try {
    await sql`CREATE TEMP TABLE dining_tables (
      id uuid DEFAULT gen_random_uuid(), qr_public_id uuid DEFAULT gen_random_uuid(),
      tenant_id uuid, branch_id uuid, name text, pos_table_id text, pos_installation_id uuid,
      qr_ordering_until timestamptz, qr_session_generation uuid,
      bill_awaiting_payment boolean NOT NULL DEFAULT false,
      UNIQUE(tenant_id, branch_id, pos_table_id)
    )`;
    await sql`CREATE TEMP TABLE table_sessions (
      tenant_id uuid, branch_id uuid, table_id uuid, token_hash text,
      expires_at timestamptz, revoked_at timestamptz, qr_generation uuid
    )`;
    await sql`CREATE TEMP TABLE connector_installations (id uuid, tenant_id uuid, branch_id uuid, revoked_at timestamptz)`;
    const app = posTableQr({
      sql, publicOrigin: 'https://ordering.example',
      authorize: (request) => request.headers.get('authorization') === 'Bearer fixture'
        ? { tenantId, branchId, installationId: null } : null,
    });
    const call = (path: string, body: object, admin = false) => app.handle(new Request(`https://ordering.example${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(admin ? { authorization: 'Bearer fixture' } : {}) },
    }));
    const connector = '/api/v1/connectors/table-qr';
    const guest = '/api/v1/table-qr/session';
    const table = { action: 'open', pos_table_id: 'local-08', name: '08' };
    expect((await call(connector, table)).status).toBe(401);
    const opened = await call(connector, table, true);
    expect(opened.status).toBe(200);
    const sticker = await opened.json();
    const key = new URLSearchParams(new URL(sticker.url).hash.slice(1)).get('table');
    expect(key).toBeTruthy();
    expect((await (await call(connector, table, true)).json()).url).toBe(sticker.url);
    expect((await call(guest, { table_key: randomUUID() })).status).toBe(409);
    const joined = await call(guest, { table_key: key });
    expect(joined.status).toBe(200);
    expect(joined.headers.get('cache-control')).toBe('no-store');
    const { table_token: token } = await joined.json();
    const [saved] = await sql`SELECT token_hash, tenant_id, branch_id, expires_at FROM table_sessions`;
    expect(saved.token_hash).toBe(sha256(token));
    expect(saved.tenant_id).toBe(tenantId);
    expect(saved.branch_id).toBe(branchId);
    expect(Date.parse(sticker.expires_at)).toBeLessThanOrEqual(saved.expires_at.getTime());
    for (let index = 0; index < 11; index++) expect((await call(guest, { table_key: key })).status).toBe(200);
    expect((await call(guest, { table_key: key })).status).toBe(429);
    expect((await call(connector, { ...table, action: 'close' }, true)).status).toBe(200);
    expect((await call(guest, { table_key: key })).status).toBe(409);
    const [active] = await sql`SELECT COUNT(*)::int AS count FROM table_sessions WHERE revoked_at IS NULL`;
    expect(active.count).toBe(0);
    expect((await (await call(connector, table, true)).json()).url).toBe(sticker.url);
    expect((await call(guest, { table_key: key })).status).toBe(200);
  } finally {
    await sql.end();
  }
});
