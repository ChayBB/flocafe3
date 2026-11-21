import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { attemptLimiter, normalizePairingCode } from './pairing';
import { inTenant } from './tenant-scope';

const databaseUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
const redisUrl = process.env.QR_NOTIFICATION_TEST_REDIS_URL;

test('pairing codes accept spacing and case but refuse look-alike characters', () => {
  expect(normalizePairingCode('kn7q-4m2x')).toBe('KN7Q4M2X');
  expect(normalizePairingCode(' KN7Q 4M2X ')).toBe('KN7Q4M2X');
  expect(normalizePairingCode('KN7Q-4M2O')).toBeNull();
  expect(normalizePairingCode('KN7Q-4M2')).toBeNull();
});

test('the attempt limiter blocks a client inside its window only', () => {
  let now = 0;
  const limiter = attemptLimiter(2, 1000, () => now);
  expect([limiter.allow('a'), limiter.allow('a'), limiter.allow('a'), limiter.allow('b')]).toEqual([true, true, false, true]);
  now = 1000;
  expect(limiter.allow('a')).toBe(true);
});

test.skipIf(!databaseUrl || !redisUrl)(
  'a one-time code hands a new POS its connector token and replaces an earlier POS',
  async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test'))
      throw Error('Use a loopback test database');
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const schema = `pairing_${randomUUID().replaceAll('-', '')}`;
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
      const env = { ...process.env, DATABASE_URL: scoped.href };

      const script = Bun.spawnSync([process.execPath, 'run', 'scripts/new-branch.ts', 'Kuk Nop', 'Hat Yai'], { env });
      const printed = script.stdout.toString();
      expect({ exit: script.exitCode, error: script.stderr.toString() }).toEqual({ exit: 0, error: '' });
      const firstCode = /Pairing code: ([2-9A-Z]{4}-[2-9A-Z]{4})/.exec(printed)![1];
      const branchId = /BranchID ([0-9a-f-]{36})/.exec(printed)![1];
      const tenantId = /Tenant:\s+([0-9a-f-]{36})/.exec(printed)![1];
      const duplicate = Bun.spawnSync([process.execPath, 'run', 'scripts/new-branch.ts', 'Kuk Nop', 'Second'], { env });
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr.toString()).toContain('--tenant');

      const admin = 'fixture-admin-pairing-only-0123456789';
      api = Bun.spawn([process.execPath, 'run', 'apps/api/src/index.ts'], {
        env: { ...env, REDIS_URL: redisUrl!, PORT: '0', ADMIN_BOOTSTRAP_TOKEN: admin, ALLOW_LEGACY_CONNECTOR_TOKEN: 'false' },
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
      const call = async (path: string, init: { bearer?: string; body?: object; client?: string } = {}) => {
        const response = await fetch(`${base}${path}`, {
          method: init.body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': init.client ?? '203.0.113.10',
            ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
        });
        const text = await response.text();
        return { status: response.status, cache: response.headers.get('cache-control'), body: text ? JSON.parse(text) : null };
      };
      const pair = (code: string, client?: string) => call('/api/v1/connectors/pair', { body: { code }, client });

      expect((await pair('2345-6789')).status).toBe(404);
      const first = await pair(firstCode.toLowerCase().replace('-', ' '));
      expect(first.status).toBe(200);
      expect(first.cache).toBe('no-store');
      expect(first.body).toMatchObject({ tenant_name: 'Kuk Nop', branch_name: 'Hat Yai' });
      expect((await call('/api/v1/connectors/catalog', { bearer: first.body.connector_token })).status).toBe(200);
      expect((await pair(firstCode)).status).toBe(404);

      expect((await call('/api/v1/admin/pairing-codes', { body: { tenant_id: tenantId, branch_id: branchId } })).status).toBe(401);
      const issue = () => call('/api/v1/admin/pairing-codes', { bearer: admin, body: { tenant_id: tenantId, branch_id: branchId } });
      const superseded = (await issue()).body.code as string;
      const replacement = await issue();
      expect(replacement.cache).toBe('no-store');
      expect((await pair(superseded)).status).toBe(404);
      const second = await pair(replacement.body.code);
      expect(second.status).toBe(200);
      expect(second.body.installation_id).toBe(first.body.installation_id);
      expect((await call('/api/v1/connectors/catalog', { bearer: first.body.connector_token })).status).toBe(401);
      expect((await call('/api/v1/connectors/catalog', { bearer: second.body.connector_token })).status).toBe(200);

      const stale = (await issue()).body.code as string;
      await sql`UPDATE connector_pairing_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`;
      expect((await pair(stale)).status).toBe(404);
      const fresh = (await issue()).body.code as string;
      for (let attempt = 0; attempt < 10; attempt += 1) await pair('2345-6789', '198.51.100.7');
      expect((await pair(fresh, '198.51.100.7')).status).toBe(429);
      expect((await pair(fresh, '198.51.100.8')).status).toBe(200);

      const hidden = await inTenant(sql, { tenantId, branchId }, (tx) => tx`SELECT count(*) FROM connector_pairing_codes`)
        .catch((error) => error.code);
      expect(hidden).toBe('42501');
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
