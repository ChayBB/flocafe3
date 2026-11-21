/**
 * Integration Test: GET /api/products/sold-by-weight lists every menu item priced by weight.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/products-sold-by-weight.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-products-sold-by-weight-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-products-sold-by-weight';

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { productRoutes } = require('../main/routes/products');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-sea', 'Seafood');
  seedCategory(db, 'cat-crab', 'Crab');
  seedProduct(db, 'p-fish', 'cat-sea', 'Fish', 400);
  seedProduct(db, 'p-crab', 'cat-crab', 'Crab', 900);
  seedProduct(db, 'p-rice', 'cat-sea', 'Rice', 20);
  seedProduct(db, 'p-special', 'cat-sea', 'Special', 0);
  seedProduct(db, 'p-shrimp', 'cat-sea', 'Shrimp', 600);
  db.prepare("UPDATE products SET sale_unit = 'kg' WHERE id = 'p-shrimp'").run();
  db.prepare("INSERT INTO addon_groups (id, name) VALUES ('g-weight', 'ราคาตามน้ำหนัก')").run();
  db.prepare(
    "INSERT INTO addon_groups (id, name, price_pending) VALUES ('g-pending', 'Market price', 1)",
  ).run();
  db.prepare(
    "INSERT INTO addon_groups (id, name, kitchen_price) VALUES ('g-kitchen', 'Chef sets', 1)",
  ).run();
  db.prepare("INSERT INTO addon_group_product VALUES ('p-fish', 'g-weight')").run();
  db.prepare("INSERT INTO category_addon_groups VALUES ('cat-crab', 'g-pending')").run();
  db.prepare("INSERT INTO addon_group_product VALUES ('p-special', 'g-kitchen')").run();

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const res = await api(baseUrl, '/api/products/sold-by-weight', { headers: authHeader });
    assertEqualOrThrow(res.status, 200, `sold-by-weight responds (${JSON.stringify(res.data)})`);
    const listed = Object.fromEntries(
      res.data.products.map((p: any) => [p.id, `${p.unit}:${p.weighed}:${p.price}`]),
    );
    assertEqualOrThrow(
      JSON.stringify(listed),
      JSON.stringify({
        'p-crab': 'kg:true:900',
        'p-fish': 'kg:true:400',
        'p-shrimp': 'kg:false:600',
      }),
      'weighed items and items sold in a weight unit are listed; kitchen-priced and per-piece items are not',
    );

    const saved = await api(baseUrl, '/api/products/p-fish', {
      method: 'PUT',
      headers: authHeader,
      body: { price: 450.5 },
    });
    assertEqualOrThrow(saved.status, 200, `a price alone saves (${JSON.stringify(saved.data)})`);
    const after = await api(baseUrl, '/api/products/sold-by-weight', { headers: authHeader });
    assertEqualOrThrow(
      after.data.products.find((p: any) => p.id === 'p-fish')?.price,
      450.5,
      'the new price reads back',
    );

    const anonymous = await api(baseUrl, '/api/products/sold-by-weight');
    assertEqualOrThrow(anonymous.status, 401, 'sold-by-weight needs a signed-in user');
    console.log('All sold-by-weight product checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
