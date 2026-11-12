/**
 * The guest menu is read once per 30 seconds, and a successful catalog write drops it at once.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/guest-menu-cache.test.ts
 */
import express from 'express';
import request from 'supertest';

const {
  GUEST_MENU_TTL_MS,
  guestMenu,
  invalidateGuestMenu,
  invalidateGuestMenuOnCatalogWrite,
} = require('../main/lib/guest-menu-cache');
const { assertEqualOrThrow } = require('./helpers/test-setup');

async function main() {
  let clock = 1_000;
  const now = () => clock;
  let loads = 0;
  const load = async () => ({ version: ++loads });

  assertEqualOrThrow((await guestMenu(load, now)).version, 1, 'the first read loads the menu');
  assertEqualOrThrow((await guestMenu(load, now)).version, 1, 'a second read is served cached');
  clock += GUEST_MENU_TTL_MS;
  assertEqualOrThrow((await guestMenu(load, now)).version, 2, 'an expired menu loads again');
  invalidateGuestMenu();
  assertEqualOrThrow((await guestMenu(load, now)).version, 3, 'an invalidated menu loads again');

  invalidateGuestMenu();
  assertEqualOrThrow(await guestMenu(async () => null, now), null, 'a failed load is passed on');
  assertEqualOrThrow((await guestMenu(load, now)).version, 4, 'and is never cached');

  invalidateGuestMenu();
  const overtaken = await guestMenu(async () => {
    invalidateGuestMenu();
    return { version: 0 };
  }, now);
  assertEqualOrThrow(overtaken.version, 0, 'a load overtaken by an edit still answers its request');
  assertEqualOrThrow((await guestMenu(load, now)).version, 5, 'but is not kept');

  invalidateGuestMenu();
  let finish: (value: { version: number }) => void;
  let concurrentLoads = 0;
  const slowLoad = () => {
    concurrentLoads++;
    return new Promise<{ version: number }>((resolve) => {
      finish = resolve;
    });
  };
  const readers = Array.from({ length: 20 }, () => guestMenu(slowLoad, now));
  await Promise.resolve();
  assertEqualOrThrow(concurrentLoads, 1, 'simultaneous guests share one catalog read');
  invalidateGuestMenu();
  const afterEdit = await guestMenu(async () => ({ version: 99 }), now);
  finish!({ version: 98 });
  const results = await Promise.all(readers);
  assertEqualOrThrow(
    results.every((result) => result.version === 98),
    true,
    'all original guests receive their menu',
  );
  assertEqualOrThrow(
    afterEdit.version,
    99,
    'an edit starts a fresh load while the old one is pending',
  );
  assertEqualOrThrow(
    (await guestMenu(load, now)).version,
    99,
    'the old flight cannot replace the edited menu',
  );

  invalidateGuestMenu();
  let failedLoads = 0;
  const failures = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      guestMenu(async () => {
        failedLoads++;
        throw new Error('catalog unavailable');
      }, now),
    ),
  );
  assertEqualOrThrow(failedLoads, 1, 'failed concurrent loads are also shared');
  assertEqualOrThrow(
    failures.every((result) => result.status === 'rejected'),
    true,
    'every caller observes the failure',
  );
  assertEqualOrThrow(
    (await guestMenu(load, now)).version,
    6,
    'a failed flight is cleared for retry',
  );

  const app = express();
  app.use(invalidateGuestMenuOnCatalogWrite);
  app.put('/api/products/:id', (_req, res) => res.json({ ok: true }));
  app.post('/api/categories', (_req, res) => res.status(400).json({ error: 'bad' }));
  app.post('/api/orders', (_req, res) => res.json({ ok: true }));
  app.get('/api/products', (_req, res) => res.json({ ok: true }));
  const cachedVersion = async () => (await guestMenu(load, now)).version;

  const steps: [string, () => Promise<unknown>, boolean][] = [
    ['a product edit', () => request(app).put('/api/products/p1').send({}), true],
    ['a refused category write', () => request(app).post('/api/categories').send({}), false],
    ['an order', () => request(app).post('/api/orders').send({}), false],
    ['a catalog read', () => request(app).get('/api/products'), false],
  ];
  for (const [label, send, drops] of steps) {
    const before = await cachedVersion();
    await send();
    assertEqualOrThrow(
      (await cachedVersion()) !== before,
      drops,
      `${label} ${drops ? 'drops' : 'keeps'} the cached menu`,
    );
  }
  console.log('Guest menu cache tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
