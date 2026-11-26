/**
 * Menu photos and branding must not spend the Server App's per-route API budget, and errors the
 * app hides from customers are written to the POS log instead.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-server-app-asset-limit-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function main() {
  console.log('Server App asset limit and client error log');
  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const log = require('electron-log');
  const warnings: unknown[][] = [];
  const originalWarn = log.warn;
  log.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const { initDatabase, getDatabase, closeDatabase } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startKdsServer, stopKdsServer } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');

  initDatabase();
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('server_app_api_rate_limit_max', '60')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run();
  await startServer();
  await startKdsServer();
  await startServerApp();
  const baseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    const imageStatuses: number[] = [];
    for (let i = 0; i < 80; i += 1) {
      const res = await fetch(`${baseUrl}/api/products/p${i}/image`);
      await res.arrayBuffer();
      imageStatuses.push(res.status);
    }
    assert.ok(!imageStatuses.includes(429), '80 menu photos in a minute are never throttled');
    const logo = await fetch(`${baseUrl}/api/server-app/branding/logo`);
    await logo.arrayBuffer();
    assert.notEqual(logo.status, 429, 'branding is not throttled by the API budget');

    const first = await fetch(`${baseUrl}/api/tables`);
    await first.arrayBuffer();
    assert.notEqual(first.status, 429, 'photos left the API budget untouched');
    assert.equal(first.headers.get('ratelimit-remaining'), '59', 'only this call was counted');

    let throttled = 0;
    for (let i = 0; i < 65; i += 1) {
      const res = await fetch(`${baseUrl}/api/tables`);
      await res.arrayBuffer();
      if (res.status === 429) throttled += 1;
    }
    assert.ok(throttled > 0, 'the API budget still throttles API calls past the limit');
    const limitLogs = warnings.filter((args) => args[0] === '[ServerApp] rate limited');
    assert.equal(limitLogs.length, 1, 'a burst of throttled calls is logged once');

    const reported = await fetch(`${baseUrl}/api/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Could not load data Bearer abcdefghijklmnop',
        audience: 'customer',
        page: '/server-standalone/',
      }),
    });
    assert.equal(reported.status, 204, 'the hidden error is accepted');
    const entry = warnings.find((args) => args[0] === '[ServerApp client error]')?.[1] as
      | Record<string, string>
      | undefined;
    assert.ok(entry, 'the hidden error is written to the POS log');
    assert.equal(entry.audience, 'customer', 'the log says a customer hit it');
    assert.ok(!entry.message.includes('abcdefghijklmnop'), 'tokens are redacted from the log');
    console.log('ALL PASSED');
  } finally {
    log.warn = originalWarn;
    await stopServerApp();
    await stopKdsServer();
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
