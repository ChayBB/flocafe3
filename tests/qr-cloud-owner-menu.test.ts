/**
 * Owner menu changes from the Cloud portal: the POS applies a price or photo only when its value is
 * still what the owner saw (or the owner chose to override), and reports every outcome back.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-cloud-owner-menu.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('node:crypto');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-owner-menu-test-'));
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
const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const { assertOrThrow, assertEqualOrThrow, getResults, resetCounters } = require('./helpers/test-setup');
const config = require('../main/services/qr-cloud/config');
const ownerMenu = require('../main/services/qr-cloud/owner-menu');

const ids = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
  d: '44444444-4444-4444-8444-444444444444',
  e: '55555555-5555-4555-8555-555555555555',
};

function png(seed: string) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
}
const nameOf = (bytes: Buffer, ext = 'png') => `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;

function priceOf(table: 'products' | 'product_variants', id: string) {
  return (getDatabase().prepare(`SELECT price FROM ${table} WHERE id = ?`).get(id) as { price: number }).price;
}

async function main() {
  resetCounters();
  initDatabase();
  const db = getDatabase();
  const oldPhoto = png('old');
  db.prepare('INSERT INTO products (id, name, price, image_url) VALUES (?, ?, ?, ?)').run(
    'p-tea',
    'Thai tea',
    45,
    `data:image/png;base64,${oldPhoto.toString('base64')}`,
  );
  db.prepare('INSERT INTO products (id, name, price) VALUES (?, ?, ?)').run('p-rice', 'Fried rice', 60);
  db.prepare('INSERT INTO product_variants (id, product_id, name, price) VALUES (?, ?, ?, ?)').run(
    'v-large',
    'p-rice',
    'Large',
    70,
  );

  const change = (over: Record<string, unknown>) => ({
    id: ids.a,
    pos_product_id: 'p-tea',
    pos_variant_id: null,
    field: 'price',
    base_value: '4500',
    new_value: '5000',
    force: false,
    ...over,
  });

  const originalRequest = https.request;
  const sent: { method: string; path: string; body: string }[] = [];
  let pending: unknown[] = [];
  https.request = (options: any, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as any;
    request.end = (body: string) => {
      sent.push({ method: options.method, path: options.path, body });
      const response = new PassThrough() as any;
      response.statusCode = 200;
      callback(response);
      response.end(JSON.stringify(options.path.endsWith('/result') ? { ok: true } : { changes: pending }));
    };
    request.destroy = () => {};
    return request;
  };

  try {
    let result = ownerMenu.applyOwnerMenuChange(change({}));
    assertEqualOrThrow(result.outcome, 'applied', 'a price the POS still holds is replaced');
    assertEqualOrThrow(priceOf('products', 'p-tea'), 50, 'the product price is stored in baht');
    const audit = db
      .prepare("SELECT details_json FROM auth_audit_log WHERE event_type = 'qr_cloud_owner_menu_change'")
      .all() as { details_json: string }[];
    assertEqualOrThrow(audit.length, 1, 'the applied change is audited');
    assertEqualOrThrow(JSON.parse(audit[0].details_json).from, '4500', 'the audit keeps the previous price');

    result = ownerMenu.applyOwnerMenuChange(change({ base_value: '4500', new_value: '5500' }));
    assertEqualOrThrow(result.outcome, 'conflict', 'a price staff changed since the owner looked is a conflict');
    assertEqualOrThrow(result.pos_value, '5000', 'the conflict reports the POS price');
    assertEqualOrThrow(priceOf('products', 'p-tea'), 50, 'a conflict leaves the POS price alone');

    result = ownerMenu.applyOwnerMenuChange(change({ base_value: '4500', new_value: '5500', force: true }));
    assertEqualOrThrow(result.outcome, 'applied', 'the owner can override the POS price');
    assertEqualOrThrow(priceOf('products', 'p-tea'), 55, 'the override is stored');

    result = ownerMenu.applyOwnerMenuChange(change({ base_value: '1', new_value: '5500' }));
    assertEqualOrThrow(result.outcome, 'applied', 'a change already matching the POS is reported applied');

    result = ownerMenu.applyOwnerMenuChange(
      change({ pos_product_id: 'p-rice', pos_variant_id: 'v-large', base_value: '7000', new_value: '7500' }),
    );
    assertEqualOrThrow(result.outcome, 'applied', 'a variant price can be changed');
    assertEqualOrThrow(priceOf('product_variants', 'v-large'), 75, 'the variant row gets the new price');
    assertEqualOrThrow(priceOf('products', 'p-rice'), 60, 'the base product keeps its price');

    for (const [over, detail] of [
      [{ pos_product_id: 'missing' }, 'product_missing'],
      [{ pos_product_id: 'p-rice', pos_variant_id: 'v-gone' }, 'variant_missing'],
      [{ new_value: '-5' }, 'price_invalid'],
      [{ new_value: '12.5' }, 'price_invalid'],
    ] as const) {
      result = ownerMenu.applyOwnerMenuChange(change(over));
      assertOrThrow(result.outcome === 'failed' && result.detail === detail, `refused: ${detail}`);
    }

    const newPhoto = png('new');
    const imageChange = (over: Record<string, unknown>) =>
      change({
        field: 'image',
        base_value: nameOf(oldPhoto),
        new_value: nameOf(newPhoto),
        image_data: newPhoto.toString('base64'),
        ...over,
      });
    result = ownerMenu.applyOwnerMenuChange(imageChange({ image_data: png('other').toString('base64') }));
    assertEqualOrThrow(result.detail, 'image_invalid', 'bytes that do not match the named photo are refused');
    result = ownerMenu.applyOwnerMenuChange(
      imageChange({ new_value: nameOf(Buffer.from('GIF89a')), image_data: Buffer.from('GIF89a').toString('base64') }),
    );
    assertEqualOrThrow(result.detail, 'image_invalid', 'a non-image upload is refused');
    result = ownerMenu.applyOwnerMenuChange(imageChange({ base_value: null }));
    assertEqualOrThrow(result.outcome, 'conflict', 'a photo staff replaced is a conflict');
    assertEqualOrThrow(result.pos_value, nameOf(oldPhoto), 'the conflict names the POS photo');
    result = ownerMenu.applyOwnerMenuChange(imageChange({}));
    assertEqualOrThrow(result.outcome, 'applied', 'the owner photo replaces the one they saw');
    const stored = (db.prepare("SELECT image_url FROM products WHERE id = 'p-tea'").get() as { image_url: string })
      .image_url;
    assertEqualOrThrow(stored, `data:image/png;base64,${newPhoto.toString('base64')}`, 'the photo is stored as a data URL');

    config.updateConfig({ cloudUrl: 'https://qr-ordering.accesscam.org' });
    config.writeConnectorToken('owner-menu-connector-token-0123456789');
    pending = [
      change({ id: ids.b, base_value: '5500', new_value: '6000' }),
      change({ id: ids.c, base_value: '100', new_value: '6500' }),
      { id: 'not-a-uuid', field: 'price' },
    ];
    ownerMenu.__resetOwnerMenuScheduleForTests();
    await ownerMenu.syncOwnerMenuChanges(config.readConfig(), new AbortController().signal);
    assertEqualOrThrow(sent[0].path, '/api/v1/connectors/menu-changes', 'pending changes are pulled');
    const reports = sent.slice(1);
    assertEqualOrThrow(reports.length, 2, 'each valid change is reported once; malformed entries are skipped');
    assertEqualOrThrow(reports[0].path, `/api/v1/connectors/menu-changes/${ids.b}/result`, 'results go to the change');
    assertEqualOrThrow(JSON.parse(reports[0].body).outcome, 'applied', 'the first change is applied');
    assertEqualOrThrow(JSON.parse(reports[1].body).outcome, 'conflict', 'the stale second change is a conflict');
    assertEqualOrThrow(priceOf('products', 'p-tea'), 60, 'the pulled change reached the POS');

    sent.length = 0;
    await ownerMenu.syncOwnerMenuChanges(config.readConfig(), new AbortController().signal);
    assertEqualOrThrow(sent.length, 0, 'the Cloud is asked at most once a minute');
  } finally {
    https.request = originalRequest;
    require('../main/services/qr-cloud/inbox').closeInbox();
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\nQR cloud owner menu: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
