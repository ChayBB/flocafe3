/**
 * Cloud catalog photos: content-addressed names in the published catalog, upload of only the
 * photos the Cloud lacks, graceful fallback for a Cloud without photo support, and the guest
 * menu preferring the Cloud photo over the static presentation snapshot.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-cloud-catalog-images.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-catalog-images-test-'));
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

const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const {
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const {
  buildCloudCatalog,
  catalogImageOf,
  uploadCatalogImages,
} = require('../main/services/qr-cloud/catalog');
const { QrCloudClientError } = require('../main/services/qr-cloud/client');
const { presentCloudMenu } = require('../frontend/src/lib/cloud-menu-presentation');

const png = (seed: number, size = 64) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.createHash('sha256').update(String(seed)).digest(),
    Buffer.alloc(size, seed),
  ]);
const dataUrl = (bytes: Buffer, type = 'png') =>
  `data:image/${type};base64,${bytes.toString('base64')}`;
const nameOf = (bytes: Buffer, ext = 'png') =>
  `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;

async function expectReject(promise: Promise<unknown>, detail: string, label: string) {
  try {
    await promise;
  } catch (error) {
    assertOrThrow(
      error instanceof QrCloudClientError && (error as { detail?: string }).detail === detail,
      label,
    );
    return;
  }
  throw new Error(`${label} - expected rejection`);
}

function verifyImageParsing() {
  const photo = png(1);
  assertEqualOrThrow(catalogImageOf(dataUrl(photo))?.name, nameOf(photo), 'PNG gets its hash name');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assertEqualOrThrow(
    catalogImageOf(dataUrl(jpeg, 'jpg'))?.name,
    nameOf(jpeg, 'jpeg'),
    'jpg data URL is named .jpeg',
  );
  assertEqualOrThrow(catalogImageOf(dataUrl(photo, 'webp')), null, 'mislabelled bytes are skipped');
  assertEqualOrThrow(catalogImageOf('https://example.com/a.png'), null, 'remote URLs are skipped');
  assertEqualOrThrow(
    catalogImageOf(dataUrl(png(2, 100_000))),
    null,
    'oversized photos are skipped',
  );
  assertEqualOrThrow(catalogImageOf(null), null, 'missing photo is null');
}

function verifyCatalog() {
  const db = getDatabase();
  const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  setting.run('country', 'TH');
  setting.run('currency', 'THB');
  db.prepare(
    "INSERT INTO categories (id, name, is_active, created_at, updated_at) VALUES ('cat-rice', 'ข้าว', 1, datetime('now'), datetime('now'))",
  ).run();
  const insert = db.prepare(`
    INSERT INTO products (id, category_id, name, price, is_active, image_url, created_at, updated_at)
    VALUES (?, 'cat-rice', ?, ?, 1, ?, datetime('now'), datetime('now'))
  `);
  const steamed = png(3);
  insert.run('p-steamed', 'ข้าวสวย', 10, dataUrl(steamed));
  insert.run('p-congee', 'ข้าวต้ม', 40, dataUrl(steamed));
  insert.run('p-plain', 'น้ำเปล่า', 10, null);
  insert.run('p-broken', 'ข้าวผัด', 50, dataUrl(steamed, 'gif'));

  const { items, images, fingerprint } = buildCloudCatalog();
  const byId = new Map(
    items.map((item: { pos_product_id: string }) => [item.pos_product_id, item]),
  );
  assertEqualOrThrow(byId.get('p-steamed').image, nameOf(steamed), 'catalog item names its photo');
  assertEqualOrThrow(byId.get('p-congee').image, nameOf(steamed), 'shared photo shares one name');
  assertOrThrow(!('image' in byId.get('p-plain')), 'item without photo has no image field');
  assertOrThrow(!('image' in byId.get('p-broken')), 'invalid photo is left out');
  assertOrThrow(
    images.get(nameOf(steamed))?.equals(steamed),
    'photo bytes travel beside the catalog',
  );
  assertOrThrow(
    !JSON.stringify(items).includes('base64'),
    'photo bytes stay out of the size-capped catalog',
  );
  assertOrThrow(!('price_unit' in byId.get('p-plain')), 'a plain item has no price unit');

  insert.run('p-fish', 'ปลากะพงสด', 180, null);
  insert.run('p-fish-ask', 'ปลาเก๋า', 0, null);
  insert.run('p-special', 'เมนูพิเศษ', 100, null);
  insert.run('p-custom', 'ตามใจฉัน', 0, null);
  const group = db.prepare('INSERT INTO addon_groups (id, name, kitchen_price) VALUES (?, ?, ?)');
  group.run('g-weight', 'ราคาตามน้ำหนัก', 0);
  group.run('g-kitchen', 'ครัวตั้งราคา', 1);
  db.prepare("UPDATE addon_groups SET description = ? WHERE id = 'g-kitchen'").run(
    'สั่งได้ตามใจ ทำให้หรอยๆ แค่รอครัวระบุราคา',
  );
  const link = db.prepare(
    'INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)',
  );
  link.run('p-fish', 'g-weight');
  link.run('p-fish-ask', 'g-weight');
  link.run('p-special', 'g-weight');
  link.run('p-special', 'g-kitchen');
  link.run('p-custom', 'g-kitchen');
  const weighed = new Map(
    buildCloudCatalog().items.map((item: { pos_product_id: string }) => [
      item.pos_product_id,
      item,
    ]),
  );
  assertEqualOrThrow(
    weighed.get('p-fish').price_unit,
    'kg',
    'a weight-priced item is priced per kg',
  );
  assertEqualOrThrow(weighed.get('p-fish').price_satang, 18000, 'the per-kg price is published');
  assertOrThrow(!('addon_groups' in weighed.get('p-fish')), 'the empty weight group stays out');
  assertOrThrow(!('price_unit' in weighed.get('p-fish-ask')), 'an ask-staff item has no unit');
  assertOrThrow(!('price_unit' in weighed.get('p-special')), 'a kitchen-priced item has no unit');
  const custom = weighed.get('p-custom');
  assertEqualOrThrow(custom.addon_groups[0].options.length, 0, 'free-form group needs no options');
  const modalGroup = presentCloudMenu([{ ...custom, id: 'cloud-custom' }]).products[0]
    .addon_groups[0];
  assertEqualOrThrow(
    modalGroup.kitchen_price,
    true,
    'the cloud customizer enables kitchen pricing',
  );
  assertEqualOrThrow(
    modalGroup.description,
    'สั่งได้ตามใจ ทำให้หรอยๆ แค่รอครัวระบุราคา',
    'the cloud customizer receives the POS group prompt',
  );
  db.prepare(
    "DELETE FROM products WHERE id IN ('p-fish', 'p-fish-ask', 'p-special', 'p-custom')",
  ).run();

  db.prepare("UPDATE products SET image_url = ? WHERE id = 'p-plain'").run(dataUrl(png(4)));
  assertOrThrow(
    buildCloudCatalog().fingerprint !== fingerprint,
    'a new photo changes the fingerprint',
  );
}

async function verifyUpload() {
  const photos = new Map<string, Buffer>();
  for (let seed = 10; seed < 20; seed += 1)
    photos.set(nameOf(png(seed, 40_000)), png(seed, 40_000));
  const names = [...photos.keys()];
  const stored = new Set(names.slice(0, 2));
  const calls: { names: string[]; images?: { name: string; data: string }[] }[] = [];
  const cloud = async (body: { names: string[]; images?: { name: string; data: string }[] }) => {
    calls.push(body);
    assertOrThrow(JSON.stringify(body).length <= 240_000, 'each upload stays under the body cap');
    for (const image of body.images ?? []) {
      const bytes = Buffer.from(image.data, 'base64');
      if (nameOf(bytes) === image.name) stored.add(image.name);
    }
    return { missing: body.names.filter((name) => !stored.has(name)) };
  };
  assertEqualOrThrow(await uploadCatalogImages(cloud, photos), true, 'upload reports support');
  assertEqualOrThrow(calls[0].images, undefined, 'first call only asks which photos are missing');
  const uploaded = calls.slice(1).flatMap((call) => call.images!.map((image) => image.name));
  assertEqualOrThrow(uploaded.length, 8, 'only the missing photos are uploaded');
  assertOrThrow(!uploaded.includes(names[0]), 'photos already in the Cloud are not re-sent');
  assertOrThrow(calls.length > 2, 'uploads are split into several requests');
  assertEqualOrThrow(stored.size, 10, 'every photo ends up in the Cloud');

  calls.length = 0;
  assertEqualOrThrow(await uploadCatalogImages(cloud, photos), true, 'republish succeeds');
  assertEqualOrThrow(calls.length, 1, 'republishing unchanged photos sends no bytes');
  assertEqualOrThrow(await uploadCatalogImages(cloud, new Map()), true, 'no photos, no calls');

  const legacy = async () => {
    throw new QrCloudClientError('bad_response', 'HTTP 404');
  };
  assertEqualOrThrow(
    await uploadCatalogImages(legacy, photos),
    false,
    'a Cloud without photo support falls back to a photo-less catalog',
  );
  await expectReject(
    uploadCatalogImages(async () => ({ missing: ['../etc/passwd'] }), photos),
    'invalid_menu_images',
    'unknown names in the reply are rejected',
  );
  await expectReject(
    uploadCatalogImages(async (body: { names: string[] }) => ({ missing: body.names }), photos),
    'menu_image_rejected',
    'a photo the Cloud refuses to store fails the publish',
  );
  const offline = async () => {
    throw new QrCloudClientError('offline');
  };
  try {
    await uploadCatalogImages(offline, photos);
    throw new Error('offline upload should fail');
  } catch (error) {
    assertEqualOrThrow((error as { code?: string }).code, 'offline', 'offline errors propagate');
  }
}

function verifyGuestMenu() {
  const hash = 'a'.repeat(64);
  const snapshot = {
    categories: [],
    popular: [],
    products: [
      {
        id: 'p-old',
        name: 'กาแฟ',
        categoryId: null,
        image: `menu-images/${'b'.repeat(64)}.png`,
        tags: [],
        variants: [],
      },
      {
        id: 'p-both',
        name: 'ชา',
        categoryId: null,
        image: `menu-images/${'c'.repeat(64)}.png`,
        tags: [],
        variants: [],
      },
    ],
  };
  const { products, images } = presentCloudMenu(
    [
      { id: 'c-old', name: 'กาแฟ', category: null, price_satang: 5000 },
      { id: 'c-both', name: 'ชา', category: null, price_satang: 4000, image: `${hash}.webp` },
      { id: 'c-new', name: 'ข้าวสวย', category: null, price_satang: 1000, image: `${hash}.png` },
    ],
    snapshot,
  );
  const imageOf = (name: string) =>
    images.get(products.find((product: { name: string }) => product.name === name)!.id);
  assertEqualOrThrow(imageOf('กาแฟ'), snapshot.products[0].image, 'static photo still works');
  assertEqualOrThrow(imageOf('ชา'), `/api/v1/menu-images/${hash}.webp`, 'Cloud photo wins');
  assertEqualOrThrow(
    imageOf('ข้าวสวย'),
    `/api/v1/menu-images/${hash}.png`,
    'a dish missing from the static snapshot shows its Cloud photo',
  );
}

function verifyGuestMenuVariants() {
  const snapshot = {
    categories: [],
    popular: [],
    products: [{ id: 'p-brandy', name: 'Brandy', categoryId: null, tags: [], variants: [] }],
  };
  const { products } = presentCloudMenu(
    [
      { id: 'c-round', name: 'Brandy – Round', category: null, price_satang: 70000 },
      { id: 'c-flat', name: 'Brandy – Flat', category: null, price_satang: 45000 },
      { id: 'c-small', name: 'Beer – Small', category: null, price_satang: 9000 },
      { id: 'c-large', name: 'Beer – Large', category: null, price_satang: 15000 },
      { id: 'c-tea', name: 'Tea', category: null, price_satang: 4000 },
    ],
    snapshot,
  );
  const variantsOf = (name: string) =>
    products
      .find((product: { name: string }) => product.name === name)
      ?.variants?.map((variant: { name: string }) => variant.name);
  assertEqualOrThrow(
    JSON.stringify(variantsOf('Brandy')),
    JSON.stringify(['Round', 'Flat']),
    'variants added after the snapshot still group under their dish',
  );
  assertEqualOrThrow(
    JSON.stringify(variantsOf('Beer')),
    JSON.stringify(['Small', 'Large']),
    'a dish missing from the snapshot groups its variants by name',
  );
  assertEqualOrThrow(products.length, 3, 'variants never show as separate dishes');
}

async function main() {
  resetCounters();
  initDatabase();
  verifyImageParsing();
  verifyCatalog();
  await verifyUpload();
  verifyGuestMenu();
  verifyGuestMenuVariants();
  closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const results = getResults();
  console.log(`\nQR cloud catalog images: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
