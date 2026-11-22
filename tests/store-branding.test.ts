/**
 * Server App header: store logo and cover validation, and the table order a QR guest may read.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/store-branding.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-store-branding-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedTable,
  seedCustomer,
  assertEqualOrThrow,
  assertOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const {
  STORE_IMAGE_MAX_LENGTH,
  decodeStoreImage,
  isStoreImageKind,
  storeImageError,
  storeImageVersion,
} = require('../main/lib/store-branding');
const { GUEST_USER_ID, guestTableOrder } = require('../main/lib/guest-order');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function main() {
  console.log('Store branding and guest table order');
  console.log('='.repeat(60));

  assertOrThrow(isStoreImageKind('logo') && isStoreImageKind('cover'), 'logo and cover are kinds');
  assertOrThrow(!isStoreImageKind('favicon'), 'other names are not');
  assertEqualOrThrow(storeImageError('logo', ''), null, 'an empty value clears the image');
  assertEqualOrThrow(storeImageError('logo', PNG), null, 'a PNG data URI is accepted');
  assertOrThrow(storeImageError('logo', 42) !== null, 'a number is rejected');
  assertOrThrow(
    storeImageError('cover', 'data:image/svg+xml;base64,PHN2Zz4=') !== null,
    'SVG is rejected, so no script can ride in on the image',
  );
  assertOrThrow(
    storeImageError('logo', 'https://example.com/logo.png') !== null,
    'a remote address is rejected',
  );
  const tooBig = `data:image/png;base64,${'A'.repeat(STORE_IMAGE_MAX_LENGTH.logo)}`;
  assertOrThrow(storeImageError('logo', tooBig) !== null, 'an oversized logo is rejected');
  assertEqualOrThrow(storeImageError('cover', tooBig), null, 'the cover may be larger');

  const decoded = decodeStoreImage(PNG);
  assertEqualOrThrow(decoded?.type, 'image/png', 'the image keeps its type');
  assertEqualOrThrow(decoded?.body.subarray(1, 4).toString(), 'PNG', 'the bytes decode');
  assertEqualOrThrow(decodeStoreImage(''), null, 'no image decodes to nothing');
  assertEqualOrThrow(storeImageVersion(''), null, 'no image has no version');
  assertOrThrow(
    storeImageVersion(PNG) !== storeImageVersion(`${PNG}A`),
    'a changed image gets a new version',
  );

  const db = initTestDb();
  seedTable(db, 'tb-1', 1);
  seedTable(db, 'tb-2', 2);
  seedCustomer(db, 'cust-a', 'Khun A');
  assertEqualOrThrow(guestTableOrder(db, 'tb-1'), null, 'a table with no open order has none');

  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, table_id, customer_id, type, status)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status)
     VALUES (?, 'p', ?, 50, ?, ?, ?, ?)`,
  );
  const paid = insertOrder.run('B-1', 'tb-1', null, 'dine_in', 'completed').lastInsertRowid;
  insertItem.run(paid, 'Yesterday soup', 1, 50, 50, 'served');
  const open = insertOrder.run('B-2', 'tb-1', 'cust-a', 'dine_in', 'preparing').lastInsertRowid;
  insertItem.run(open, 'Fried rice', 2, 100, 100, 'preparing');
  insertItem.run(open, 'Iced tea', 1, 50, 50, 'cancelled');
  insertItem.run(open, 'Voided line', 1, 50, 50, 'voided');
  insertOrder.run('B-3', 'tb-2', null, 'dine_in', 'pending');

  const order = guestTableOrder(db, 'tb-1');
  assertEqualOrThrow(order?.order_number, 'B-2', 'the open order is shown, not a paid one');
  assertEqualOrThrow(order?.customer_name, 'Khun A', 'the customer name comes along');
  assertEqualOrThrow(
    order?.items.map((item: { product_name: string }) => item.product_name).join(','),
    'Fried rice,Iced tea',
    'cancelled lines stay visible and voided ones are hidden',
  );
  assertEqualOrThrow(
    Object.keys(order!.items[0]).sort().join(','),
    'created_at,id,ordered_by,ordered_by_guest,product_id,product_name,quantity,status,total',
    'only the fields a guest needs leave the server',
  );
  assertEqualOrThrow(
    guestTableOrder(db, 'tb-2')?.items.length,
    0,
    "another table's order is its own",
  );

  checkOrderedByAndBill(db);

  closeDatabase();
  console.log('All store branding checks passed');
}

function checkOrderedByAndBill(db: any) {
  const addUser = db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active) VALUES (?, ?, ?, 'x', ?, 1)`,
  );
  addUser.run('u-ann', 'Ann', 'ann@test.local', 'server');
  addUser.run('u-bo', 'Bo', 'bo@test.local', 'server');
  addUser.run(GUEST_USER_ID, 'Guest', 'guest@test.local', 'server');
  seedTable(db, 'tb-3', 3);
  seedTable(db, 'tb-4', 4);

  const insertOrder = db.prepare(
    `INSERT INTO orders (order_number, table_id, user_id, type, status, subtotal, discount_amount,
       service_charge, tax_amount, round_off, total)
     VALUES (?, ?, ?, 'dine_in', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, tax_type)
     VALUES (?, ?, ?, 40, 1, 40, 40, 'preparing', 'exclusive')`,
  );
  const audit = db.prepare(
    `INSERT INTO order_audit_log (order_id, actor_user_id, action, details_json) VALUES (?, ?, ?, ?)`,
  );

  const order = insertOrder.run(
    'B-4',
    'tb-3',
    'u-ann',
    'pending',
    120,
    10,
    5,
    8.4,
    0.6,
    124,
  ).lastInsertRowid;
  insertItem.run(order, 'p-tea', 'Thai tea');
  const byGuest = insertItem.run(order, 'p-plain', 'Water').lastInsertRowid;
  const byBo = insertItem.run(order, 'gone', 'Retired dish').lastInsertRowid;
  audit.run(order, GUEST_USER_ID, 'items_added', JSON.stringify({ item_ids: [byGuest] }));
  audit.run(order, 'u-bo', 'items_added', JSON.stringify({ item_ids: [Number(byBo)] }));

  const seen = guestTableOrder(db, 'tb-3');
  const [tea, water, retired] = seen.items;
  assertEqualOrThrow(tea.ordered_by, 'Ann', 'items that came with the order belong to its creator');
  assertEqualOrThrow(water.ordered_by, null, 'a guest is not named');
  assertEqualOrThrow(water.ordered_by_guest, true, 'a guest line is marked as the guest');
  assertEqualOrThrow(retired.ordered_by, 'Bo', 'staff who added a dish later are named');
  assertEqualOrThrow(
    JSON.stringify(seen.bill),
    JSON.stringify({
      subtotal: 120,
      discount_amount: 10,
      service_charge: 5,
      tax_amount: 8.4,
      tax_included: false,
      round_off: 0.6,
      total: 124,
    }),
    'the bill comes from the order totals the backend keeps',
  );

  const source = insertOrder.run(
    'B-5',
    'tb-4',
    'u-bo',
    'completed',
    0,
    0,
    0,
    0,
    0,
    0,
  ).lastInsertRowid;
  const target = insertOrder.run(
    'B-6',
    'tb-4',
    'u-ann',
    'pending',
    80,
    0,
    0,
    0,
    0,
    80,
  ).lastInsertRowid;
  insertItem.run(target, 'p-plain', 'Target first');
  const guestSourceItem = insertItem.run(source, 'p-plain', 'Source by guest').lastInsertRowid;
  audit.run(source, GUEST_USER_ID, 'items_added', JSON.stringify({ item_ids: [guestSourceItem] }));
  db.prepare('UPDATE order_items SET order_id = ? WHERE order_id = ?').run(target, source);
  const merge = JSON.stringify({ from_order: 'B-5', to_order: 'B-6', items: 1 });
  audit.run(source, 'u-ann', 'order_merged', merge);
  audit.run(target, 'u-ann', 'order_merged', merge);
  const merged = guestTableOrder(db, 'tb-4');
  assertEqualOrThrow(
    merged.items.map((item: any) => `${item.ordered_by}/${item.ordered_by_guest}`).join(','),
    'null/false,null/true',
    'after a merge, audited lines keep their author and the rest are not guessed',
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
