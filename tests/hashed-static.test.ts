/**
 * Content-hashed Server App assets are served compressed and immutable; everything else falls through.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/hashed-static.test.ts
 */
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { hashedStaticAssets } = require('../main/lib/hashed-static');
const { sendCachedJson } = require('../main/lib/compressed-json');
const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-hashed-static-'));
  const chunk = path.join(root, '_next', 'static', 'chunks');
  fs.mkdirSync(chunk, { recursive: true });
  const script = 'console.log("guest menu");'.repeat(200);
  fs.writeFileSync(path.join(chunk, 'app-abc123.js'), script);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');
  const app = express();
  app.use(hashedStaticAssets(root));
  app.use((_req, res) => res.status(418).send('fallthrough'));

  const br = await request(app)
    .get('/_next/static/chunks/app-abc123.js')
    .set('Accept-Encoding', 'br, gzip');
  assertEqualOrThrow(br.status, 200, 'hashed asset is served');
  assertEqualOrThrow(br.headers['content-encoding'], 'br', 'brotli is preferred');
  assertEqualOrThrow(
    br.headers['cache-control'],
    'public, max-age=31536000, immutable',
    'hashed asset is immutable',
  );
  assertEqualOrThrow(br.text, script, 'brotli body round-trips');
  assertOrThrow(
    Number(br.headers['content-length']) < script.length / 4,
    'brotli body is smaller than the source',
  );

  const gz = await request(app)
    .get('/_next/static/chunks/app-abc123.js')
    .set('Accept-Encoding', 'gzip');
  assertEqualOrThrow(
    gz.headers['content-encoding'],
    'gzip',
    'gzip is used when brotli is not accepted',
  );
  assertEqualOrThrow(gz.text, script, 'gzip body round-trips');

  const identity = await request(app)
    .get('/_next/static/chunks/app-abc123.js')
    .set('Accept-Encoding', 'identity');
  assertEqualOrThrow(identity.status, 418, 'uncompressed requests fall through to express.static');

  const missing = await request(app)
    .get('/_next/static/chunks/missing.js')
    .set('Accept-Encoding', 'br');
  assertEqualOrThrow(missing.status, 418, 'missing files fall through');

  const escape = await request(app)
    .get('/_next/static/..%2F..%2Fsecret.txt')
    .set('Accept-Encoding', 'br');
  assertEqualOrThrow(escape.status, 418, 'non-asset paths fall through');

  fs.rmSync(root, { recursive: true, force: true });

  const menu = {
    products: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: 'Iced latte' })),
  };
  const jsonApp = express();
  jsonApp.get('/menu', (req, res) => void sendCachedJson(req, res, menu));
  const zipped = await request(jsonApp).get('/menu').set('Accept-Encoding', 'gzip');
  assertEqualOrThrow(zipped.headers['content-encoding'], 'gzip', 'cached JSON is gzip-compressed');
  assertEqualOrThrow(JSON.stringify(zipped.body), JSON.stringify(menu), 'gzip JSON round-trips');
  assertOrThrow(
    Number(zipped.headers['content-length']) < JSON.stringify(menu).length / 4,
    'gzip JSON is smaller than the source',
  );
  const plain = await request(jsonApp).get('/menu').set('Accept-Encoding', 'identity');
  assertEqualOrThrow(
    plain.headers['content-encoding'],
    undefined,
    'identity requests get plain JSON',
  );
  assertEqualOrThrow(JSON.stringify(plain.body), JSON.stringify(menu), 'plain JSON matches');
  console.log('Hashed static assets: all checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
