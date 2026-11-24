/**
 * Cloud QR branding: the Settings logo and cover reach the Cloud through the connector, in parts
 * small enough for the proxy, only when they change, with retries when the Cloud is unreachable.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-cloud-branding.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-branding-test-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => tempRoot, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
        decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8'),
      },
    };
  return originalLoad.apply(this, arguments as never);
};
process.env.FLO_QR_CLOUD_DIR = path.join(tempRoot, 'qr-cloud');

const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  initTestDb,
  closeDatabase,
  now,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const config = require('../main/services/qr-cloud/config');
const branding = require('../main/services/qr-cloud/branding');

const png = (size: number, seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size, seed),
  ]);
const nameOf = (bytes: Buffer, ext = 'png') =>
  `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;

/** A Cloud that behaves like qr-saas store-branding: stages parts, then selects once all arrive. */
function fakeCloud() {
  const images = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer>();
  const state = {
    selection: null as null | { logo: string | null; cover: string | null },
    bodies: [] as any[],
    requests: 0,
    status: 200,
    offline: false,
  };
  const handle = (body: any) => {
    state.bodies.push(body);
    if (body.part) {
      const { name, offset, data } = body.part;
      const current = uploads.get(name) ?? Buffer.alloc(0);
      if (offset === 0) uploads.set(name, Buffer.from(data, 'base64'));
      else if (current.length === offset)
        uploads.set(name, Buffer.concat([current, Buffer.from(data, 'base64')]));
      const staged = uploads.get(name);
      if (staged && staged.length === body.part.total && nameOf(staged) === name) {
        images.set(name, staged);
        uploads.delete(name);
      }
    }
    const names = [body.logo, body.cover].filter((name) => name !== null);
    const missing = names.filter((name) => !images.has(name));
    if (!missing.length) state.selection = { logo: body.logo, cover: body.cover };
    return {
      missing: missing.map((name) => ({ name, received: uploads.get(name)?.length ?? 0 })),
    };
  };
  const originalRequest = https.request;
  https.request = (options: any, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as any;
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.end = (raw: string) => {
      state.requests += 1;
      if (state.offline) {
        setImmediate(() =>
          request.emit('error', Object.assign(new Error('offline'), { code: 'ENOTFOUND' })),
        );
        return;
      }
      assertEqualOrThrow(options.path, '/api/v1/connectors/branding', 'branding uses its route');
      assertOrThrow(raw.length < 200_000, 'each request stays under the Cloud proxy limit');
      const response = new PassThrough() as any;
      response.statusCode = state.status;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.end(JSON.stringify(state.status === 200 ? handle(JSON.parse(raw)) : { error: 'x' }));
    };
    return request;
  };
  return { images, state, restore: () => (https.request = originalRequest) };
}

async function main() {
  resetCounters();
  const db = initTestDb();
  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  const logo = png(3_000, 1);
  const cover = png(400_000, 2);
  setSetting('store_logo', `data:image/png;base64,${logo.toString('base64')}`);
  setSetting('store_cover', `data:image/png;base64,${cover.toString('base64')}`);

  const read = branding.readStoreBrandingImages();
  assertEqualOrThrow(read.logo.name, nameOf(logo), 'the logo is named by its content hash');
  assertOrThrow(read.cover.bytes.equals(cover), 'the cover bytes are decoded from Settings');

  config.updateConfig({ cloudUrl: 'https://qr-ordering.accesscam.org' });
  config.writeConnectorToken('branding-connector-token-0123456789abcdef');
  const cloud = fakeCloud();
  const signal = new AbortController().signal;
  try {
    branding.__resetStoreBrandingSyncForTests();
    await branding.syncStoreBranding(config.readConfig(), signal, 1_000);
    assertEqualOrThrow(
      JSON.stringify(cloud.state.selection),
      JSON.stringify({ logo: nameOf(logo), cover: nameOf(cover) }),
      'the Cloud selects the Settings logo and cover',
    );
    assertOrThrow(cloud.images.get(nameOf(cover))?.equals(cover), 'the cover arrives intact');
    assertOrThrow(
      cloud.state.bodies.filter((body) => body.part?.name === nameOf(cover)).length > 1,
      'a cover larger than one request is sent in parts',
    );

    const sentBefore = cloud.state.bodies.length;
    await branding.syncStoreBranding(config.readConfig(), signal, 2_000);
    assertEqualOrThrow(cloud.state.bodies.length, sentBefore, 'unchanged branding is not resent');

    const newLogo = png(2_000, 3);
    setSetting('store_logo', `data:image/png;base64,${newLogo.toString('base64')}`);
    setSetting('store_cover', '');
    const coverParts = () =>
      cloud.state.bodies.filter((body) => body.part?.name === nameOf(cover)).length;
    const coverPartsBefore = coverParts();
    cloud.state.offline = true;
    let failed = false;
    await branding.syncStoreBranding(config.readConfig(), signal, 3_000).catch(() => {
      failed = true;
    });
    assertOrThrow(failed, 'an offline push fails without touching the POS');
    cloud.state.offline = false;
    const sentOffline = cloud.state.bodies.length;
    await branding.syncStoreBranding(config.readConfig(), signal, 30_000);
    assertEqualOrThrow(
      cloud.state.bodies.length,
      sentOffline,
      'a failed push waits before retrying',
    );
    await branding.syncStoreBranding(config.readConfig(), signal, 70_000);
    assertEqualOrThrow(
      JSON.stringify(cloud.state.selection),
      JSON.stringify({ logo: nameOf(newLogo), cover: null }),
      'the retry delivers the new logo and the cleared cover',
    );
    assertEqualOrThrow(coverParts(), coverPartsBefore, 'the cleared cover is not uploaded again');

    setSetting('store_cover', `data:image/png;base64,${cover.toString('base64')}`);
    const sentHeld = cloud.state.bodies.length;
    await branding.syncStoreBranding(config.readConfig(), signal, 80_000);
    assertEqualOrThrow(
      cloud.state.bodies.length - sentHeld,
      1,
      'an image the Cloud already holds is selected without re-uploading it',
    );

    cloud.state.status = 404;
    setSetting('store_logo', '');
    branding.__resetStoreBrandingSyncForTests();
    const requestsOld = cloud.state.requests;
    await branding.syncStoreBranding(config.readConfig(), signal, 100_000).catch(() => {});
    assertEqualOrThrow(cloud.state.requests, requestsOld + 1, 'the push reaches the older Cloud');
    cloud.state.status = 200;
    await branding.syncStoreBranding(config.readConfig(), signal, 1_000_000);
    assertEqualOrThrow(
      cloud.state.requests,
      requestsOld + 1,
      'a Cloud without the branding route is retried only hourly',
    );
    await branding.syncStoreBranding(config.readConfig(), signal, 100_000 + 3_600_001);
    assertEqualOrThrow(cloud.state.selection?.logo, null, 'after an hour the push is tried again');

    setSetting('store_logo', `data:image/png;base64,${newLogo.toString('base64')}`);
    const beforeSave = cloud.state.requests;
    branding.pushStoreBrandingSoon();
    assertEqualOrThrow(cloud.state.requests, beforeSave, 'a disabled connector pushes nothing');
    config.updateConfig({ enabled: true, mode: 'integrated' });
    branding.pushStoreBrandingSoon();
    assertOrThrow(
      cloud.state.requests > beforeSave,
      'saving starts the push without waiting a poll',
    );
    await branding.syncStoreBranding(config.readConfig(), signal);
    assertEqualOrThrow(
      cloud.state.selection?.logo,
      nameOf(newLogo),
      'saving the logo pushes it at once when the connector is on',
    );

    let rejected = false;
    await branding
      .uploadStoreBranding(
        async () => ({ missing: [{ name: 'other.png', received: 0 }] }),
        read.logo,
        null,
      )
      .catch(() => {
        rejected = true;
      });
    assertOrThrow(rejected, 'a reply naming an image the POS did not send is refused');
    let stalled = false;
    await branding
      .uploadStoreBranding(
        async () => ({ missing: [{ name: read.logo.name, received: 0 }] }),
        read.logo,
        null,
      )
      .catch(() => {
        stalled = true;
      });
    assertOrThrow(stalled, 'a Cloud that never accepts the image stops the upload loop');
  } finally {
    cloud.restore();
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\nQR cloud branding: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
