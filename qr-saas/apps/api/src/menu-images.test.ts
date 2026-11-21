import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { publishCatalog } from './catalog-sync';
import { menuImages, postgresMenuImageStore, verifiedMenuImage, type MenuImageStore } from './menu-images';

const png = (seed: number) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, seed),
]);
const nameOf = (bytes: Buffer, ext = 'png') => `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;

function memoryStore(): MenuImageStore & { rows: Map<string, Buffer> } {
  const rows = new Map<string, Buffer>();
  return {
    rows,
    async save(tenantId, images) {
      for (const image of images) if (!rows.has(`${tenantId}/${image.name}`)) rows.set(`${tenantId}/${image.name}`, image.bytes);
    },
    async present(tenantId, names) {
      return names.filter((name) => rows.has(`${tenantId}/${name}`));
    },
    async read(name) {
      for (const [key, bytes] of rows) if (key.endsWith(`/${name}`)) return bytes;
      return null;
    },
  };
}

const tenantA = randomUUID();
const tenantB = randomUUID();
function app(store = memoryStore()) {
  const plugin = menuImages({
    store,
    authorize: (request) => {
      const auth = request.headers.get('authorization');
      if (auth === 'Bearer a') return { tenantId: tenantA, branchId: randomUUID(), installationId: null };
      if (auth === 'Bearer b') return { tenantId: tenantB, branchId: randomUUID(), installationId: null };
      return null;
    },
  });
  const upload = (body: unknown, authorization = 'Bearer a') => plugin.handle(new Request(
    'http://localhost/api/v1/connectors/menu-images',
    { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  ));
  const read = (name: string) => plugin.handle(new Request(`http://localhost/api/v1/menu-images/${name}`));
  return { store, upload, read };
}

test('photo bytes must match their hash name and file type', () => {
  const photo = png(1);
  expect(verifiedMenuImage(nameOf(photo), photo.toString('base64'))?.equals(photo)).toBe(true);
  expect(verifiedMenuImage(nameOf(png(2)), photo.toString('base64'))).toBeNull();
  expect(verifiedMenuImage(nameOf(photo, 'webp'), photo.toString('base64'))).toBeNull();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(verifiedMenuImage(nameOf(svg), svg.toString('base64'))).toBeNull();
  expect(verifiedMenuImage(nameOf(photo), 'not base64!')).toBeNull();
  const big = Buffer.concat([png(3), Buffer.alloc(131_072)]);
  expect(verifiedMenuImage(nameOf(big), big.toString('base64'))).toBeNull();
});

test('connectors upload only missing photos and see their own tenant only', async () => {
  const { upload, store } = app();
  const one = png(1);
  const two = png(2);
  const names = [nameOf(one), nameOf(two)];
  expect((await upload({ names }, '')).status).toBe(401);
  expect((await upload({ names: ['../x.png'] })).status).toBe(422);
  expect((await upload({ names: [names[0], names[0]] })).status).toBe(400);

  const first = await upload({ names });
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(await first.json()).toEqual({ missing: names });

  const stored = await upload({ names, images: [
    { name: names[0], data: one.toString('base64') },
    { name: names[1], data: one.toString('base64') },
  ] });
  expect(await stored.json()).toEqual({ missing: [names[1]] });
  expect(store.rows.size).toBe(1);

  const outside = await upload({ names: [names[0]], images: [] });
  expect(await outside.json()).toEqual({ missing: [] });
  const unlisted = await upload({ names: [names[0]], images: [{ name: names[1], data: two.toString('base64') }] });
  expect(await unlisted.json()).toEqual({ missing: [] });
  expect(store.rows.size).toBe(1);

  expect(await (await upload({ names }, 'Bearer b')).json()).toEqual({ missing: names });
});

test('guests read photos by name with a one-year immutable cache', async () => {
  const { upload, read } = app();
  const photo = png(4);
  const name = nameOf(photo);
  expect((await read(name)).status).toBe(404);
  await upload({ names: [name], images: [{ name, data: photo.toString('base64') }] });
  const response = await read(name);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await response.arrayBuffer()).equals(photo)).toBe(true);
  expect((await read('abc.png')).status).toBe(404);
  expect((await read(`${name.slice(0, 64)}.svg`)).status).toBe(404);
});

const testUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;

test.skipIf(!testUrl)('Postgres stores photos and catalog publish keeps each item photo', async () => {
  const url = new URL(testUrl!);
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) throw Error('Use a loopback test database');
  const sql = postgres(testUrl!, { max: 1 });
  const tenantId = randomUUID();
  const branchId = randomUUID();
  try {
    await sql`CREATE TEMP TABLE menu_images (
      tenant_id uuid NOT NULL, name text NOT NULL CHECK(name ~ '^[a-f0-9]{64}\\.(webp|png|jpeg|gif)$'),
      bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id, name)
    )`;
    await sql`CREATE TEMP TABLE branches (tenant_id uuid, id uuid, menu_revision uuid, menu_revision_hash text)`;
    await sql`CREATE TEMP TABLE menu_items (
      tenant_id uuid, branch_id uuid, external_id text, name text, price_satang int, price_unit text, available boolean,
      category text, pos_product_id text, pos_variant_id text, addon_groups jsonb, image text,
      updated_at timestamptz, UNIQUE(tenant_id, branch_id, external_id)
    )`;
    await sql`INSERT INTO branches (tenant_id, id) VALUES (${tenantId}, ${branchId})`;
    await sql.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qr_app') THEN CREATE ROLE qr_app NOLOGIN; END IF; END $$`);
    await sql.unsafe('GRANT ALL ON menu_images, branches, menu_items TO qr_app');
    const store = postgresMenuImageStore(sql);
    const photo = png(5);
    const name = nameOf(photo);
    await store.save(tenantId, [{ name, bytes: photo }]);
    await store.save(tenantId, [{ name, bytes: photo }]);
    expect(await store.present(tenantId, [name, nameOf(png(6))])).toEqual([name]);
    expect(await store.present(randomUUID(), [name])).toEqual([]);
    expect((await store.read(name))?.equals(photo)).toBe(true);

    const scope = { tenantId, branchId, installationId: null };
    const item = { external_id: 'p1', pos_product_id: 'p1', pos_variant_id: null, name: 'ข้าวสวย', category: null, price_satang: 1000 };
    const first = randomUUID();
    expect(await publishCatalog(sql, scope, { revision: first, base_revision: null, items: [{ ...item, image: name }] })).toBe('published');
    expect((await sql`SELECT image FROM menu_items WHERE external_id = 'p1'`)[0].image).toBe(name);
    expect(await publishCatalog(sql, scope, { revision: randomUUID(), base_revision: first, items: [item] })).toBe('published');
    expect((await sql`SELECT image FROM menu_items WHERE external_id = 'p1'`)[0].image).toBeNull();
  } finally {
    await sql.end();
  }
});
