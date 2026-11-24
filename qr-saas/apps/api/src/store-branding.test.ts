import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { ConnectorIdentity } from './connector-auth';
import {
  MAX_BRANDING_PART_CHARS,
  postgresBrandingStore,
  storeBranding,
  verifiedBrandingImage,
  type BrandingSelection,
  type BrandingStore,
} from './store-branding';

const png = (size: number, seed = 1) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, seed)]);
const nameOf = (bytes: Buffer, ext = 'png') => `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;

function memoryStore() {
  const uploads = new Map<string, Buffer>();
  const images = new Map<string, Buffer>();
  const selections = new Map<string, BrandingSelection>();
  const key = (scope: ConnectorIdentity, name: string) => `${scope.tenantId}/${scope.branchId}/${name}`;
  const store: BrandingStore = {
    async stage(scope, name, offset, part) {
      const current = uploads.get(key(scope, name));
      if (offset !== 0 && current?.length !== offset) return null;
      const next = offset === 0 ? part : Buffer.concat([current!, part]);
      uploads.set(key(scope, name), next);
      return next;
    },
    async staged(scope, names) {
      return new Map(names.flatMap((name) => {
        const bytes = uploads.get(key(scope, name));
        return bytes ? [[name, bytes.length] as [string, number]] : [];
      }));
    },
    async save(scope, name, bytes) {
      if (!images.has(`${scope.tenantId}/${name}`)) images.set(`${scope.tenantId}/${name}`, bytes);
      uploads.delete(key(scope, name));
    },
    async discard(scope, name) {
      uploads.delete(key(scope, name));
    },
    async present(tenantId, names) {
      return names.filter((name) => images.has(`${tenantId}/${name}`));
    },
    async select(scope, selection) {
      selections.set(`${scope.tenantId}/${scope.branchId}`, selection);
    },
    async read(name) {
      for (const [k, bytes] of images) if (k.endsWith(`/${name}`)) return bytes;
      return null;
    },
  };
  return { store, uploads, images, selections };
}

const branchA: ConnectorIdentity = { tenantId: randomUUID(), branchId: randomUUID(), installationId: null };
function app(memory = memoryStore()) {
  const plugin = storeBranding({
    store: memory.store,
    authorize: (request) => (request.headers.get('authorization') === 'Bearer a' ? branchA : null),
  });
  const push = async (body: unknown, authorization = 'Bearer a') => {
    const response = await plugin.handle(new Request('http://localhost/api/v1/connectors/branding', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  const read = (name: string) => plugin.handle(new Request(`http://localhost/api/v1/menu-images/branding/${name}`));
  return { ...memory, push, read };
}

/** Sends every part the cloud reports as missing, as the POS connector does. */
async function upload(cloud: ReturnType<typeof app>, selection: BrandingSelection, files: Map<string, Buffer>) {
  let reply = await cloud.push(selection);
  for (let round = 0; reply.body.missing?.length && round < 50; round += 1) {
    const { name, received } = reply.body.missing[0];
    const bytes = files.get(name)!;
    const chunk = bytes.subarray(received, received + (MAX_BRANDING_PART_CHARS / 4) * 3);
    reply = await cloud.push({ ...selection, part: { name, offset: received, total: bytes.length, data: chunk.toString('base64') } });
  }
  return reply;
}

test('branding images must match their hash name, file type and size cap', () => {
  const logo = png(64);
  expect(verifiedBrandingImage(nameOf(logo), logo)).toBe(true);
  expect(verifiedBrandingImage(nameOf(logo, 'jpeg'), logo)).toBe(false);
  expect(verifiedBrandingImage(nameOf(png(64, 2)), logo)).toBe(false);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(verifiedBrandingImage(nameOf(svg), svg)).toBe(false);
  const huge = png(1_600_000);
  expect(verifiedBrandingImage(nameOf(huge), huge)).toBe(false);
});

test('a cover larger than one request arrives in parts and becomes the branch branding', async () => {
  const cloud = app();
  const logo = png(2_000, 3);
  const cover = png(700_000, 4);
  const selection = { logo: nameOf(logo), cover: nameOf(cover) };
  const first = await cloud.push(selection);
  expect(first.body.missing).toEqual([
    { name: selection.logo, received: 0 },
    { name: selection.cover, received: 0 },
  ]);
  expect(cloud.selections.size).toBe(0);
  const done = await upload(cloud, selection, new Map([[selection.logo, logo], [selection.cover, cover]]));
  expect(done).toEqual({ status: 200, body: { missing: [] } });
  expect(cloud.selections.get(`${branchA.tenantId}/${branchA.branchId}`)).toEqual(selection);
  expect(cloud.uploads.size).toBe(0);

  const served = await cloud.read(selection.cover);
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type')).toBe('image/png');
  expect(served.headers.get('cache-control')).toContain('immutable');
  expect(Buffer.from(await served.arrayBuffer()).equals(cover)).toBe(true);
});

test('an image already held is selected without re-sending, and clearing selects nothing', async () => {
  const cloud = app();
  const logo = png(500, 5);
  const selection = { logo: nameOf(logo), cover: null };
  await upload(cloud, selection, new Map([[selection.logo, logo]]));
  cloud.selections.clear();
  expect(await cloud.push(selection)).toEqual({ status: 200, body: { missing: [] } });
  expect(cloud.selections.get(`${branchA.tenantId}/${branchA.branchId}`)).toEqual(selection);
  expect(await cloud.push({ logo: null, cover: null })).toEqual({ status: 200, body: { missing: [] } });
  expect(cloud.selections.get(`${branchA.tenantId}/${branchA.branchId}`)).toEqual({ logo: null, cover: null });
});

test('a stale part offset resumes from what the cloud holds', async () => {
  const cloud = app();
  const cover = png(300_000, 6);
  const selection = { logo: null, cover: nameOf(cover) };
  const part = (offset: number, size: number) => ({
    ...selection,
    part: { name: selection.cover, offset, total: cover.length, data: cover.subarray(offset, offset + size).toString('base64') },
  });
  expect((await cloud.push(part(0, 90_000))).body.missing).toEqual([{ name: selection.cover, received: 90_000 }]);
  expect((await cloud.push(part(120_000, 90_000))).body.missing).toEqual([{ name: selection.cover, received: 90_000 }]);
  const done = await upload(cloud, selection, new Map([[selection.cover, cover]]));
  expect(done.body.missing).toEqual([]);
});

test('corrupt or foreign uploads are rejected and nothing is selected', async () => {
  const cloud = app();
  const logo = png(400, 7);
  const name = nameOf(logo);
  const forged = png(400, 8);
  const rejected = await cloud.push({
    logo: name,
    cover: null,
    part: { name, offset: 0, total: forged.length, data: forged.toString('base64') },
  });
  expect(rejected.status).toBe(422);
  expect(cloud.uploads.size).toBe(0);
  expect(cloud.selections.size).toBe(0);

  const other = png(300, 9);
  const unrelated = await cloud.push({
    logo: name,
    cover: null,
    part: { name: nameOf(other), offset: 0, total: other.length, data: other.toString('base64') },
  });
  expect(unrelated.status).toBe(400);
  expect((await cloud.push({ logo: name, cover: null }, 'Bearer x')).status).toBe(401);
  expect((await cloud.read(name)).status).toBe(404);
  expect((await cloud.read('not-a-name.png')).status).toBe(404);
});

const testUrl = process.env.QR_NOTIFICATION_TEST_DATABASE_URL;
test.skipIf(!testUrl)('Postgres stages parts, stores the image and selects the branch branding', async () => {
  const sql = postgres(testUrl!, { max: 1 });
  try {
    const [tenant] = await sql<{ id: string }[]>`INSERT INTO tenants (name) VALUES ('branding') RETURNING id`;
    const [branch] = await sql<{ id: string }[]>`INSERT INTO branches (tenant_id, name) VALUES (${tenant.id}, 'b') RETURNING id`;
    const scope = { tenantId: tenant.id, branchId: branch.id, installationId: null };
    const store = postgresBrandingStore(sql);
    const cover = png(200_000, 10);
    const name = nameOf(cover);
    expect((await store.stage(scope, name, 0, cover.subarray(0, 100_000)))?.length).toBe(100_000);
    expect(await store.stage(scope, name, 5, cover.subarray(100_000))).toBeNull();
    const staged = await store.stage(scope, name, 100_000, cover.subarray(100_000));
    expect(staged?.equals(cover)).toBe(true);
    await store.save(scope, name, staged!);
    expect(await store.staged(scope, [name])).toEqual(new Map());
    expect(await store.present(tenant.id, [name])).toEqual([name]);
    await store.select(scope, { logo: null, cover: name });
    const [row] = await sql`SELECT store_logo, store_cover, branding_updated_at FROM branches WHERE id = ${branch.id}`;
    expect(row.store_cover).toBe(name);
    expect(row.store_logo).toBeNull();
    expect(row.branding_updated_at).not.toBeNull();
    expect((await store.read(name))?.equals(cover)).toBe(true);
  } finally {
    await sql.end();
  }
});
