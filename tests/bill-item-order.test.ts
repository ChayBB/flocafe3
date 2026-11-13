import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-order-'));
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};
const { initTestDb, seedCategory, seedProduct, closeDatabase } = require('./helpers/test-setup');
const { sortBillItems } = require('../main/lib/bill-item-order');
const { getOrderWithItems } = require('../main/routes/bills');

const db = initTestDb();
try {
  seedCategory(db, 'food', 'Food');
  seedCategory(db, 'drinks', 'เครื่องดื่ม');
  seedCategory(db, 'coffee', 'Coffee');
  seedCategory(db, 'juice', 'Juice');
  db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run('drinks', 'coffee');
  db.prepare('INSERT INTO kitchen_stations (id, name, category_ids) VALUES (?, ?, ?)').run(
    'bar',
    'บาร์น้ำ',
    JSON.stringify(['juice']),
  );
  const catalog = [
    ['ice', 'food', 'น้ำแข็งถัง'],
    ['tea', 'drinks', 'Tea'],
    ['rice', 'food', 'Fried rice'],
    ['coffee', 'coffee', 'Latte'],
    ['juice', 'juice', 'Orange juice'],
    ['dessert', 'food', 'Ice cream'],
    ['iced', 'food', 'Iced cake'],
    ['shaved', 'food', 'น้ำแข็งไส'],
    ['ice-cubes', 'food', 'Ice cubes'],
  ];
  for (const [id, category, name] of catalog) seedProduct(db, id, category, name, 50);
  const lines = catalog.map(([product_id, , product_name], index) => ({
    product_id,
    product_name,
    quantity: index + 1,
    total: (index + 1) * 50,
  }));
  const expected = [
    'rice',
    'dessert',
    'iced',
    'shaved',
    'tea',
    'coffee',
    'juice',
    'ice',
    'ice-cubes',
  ];
  const sorted = sortBillItems(db, lines);
  assert.deepEqual(
    sorted.map((item: (typeof lines)[number]) => item.product_id),
    expected,
  );
  assert.deepEqual(
    lines.map((item) => item.product_id),
    catalog.map(([id]) => id),
  );
  for (const item of sorted)
    assert.equal(
      item,
      lines.find((line) => line.product_id === item.product_id),
    );
  assert.deepEqual(sortBillItems(db, [], null), []);
  assert.deepEqual(
    sortBillItems(db, lines, 'bar').map((item: (typeof lines)[number]) => item.product_id),
    [
      ...catalog.filter(([id]) => !['ice', 'ice-cubes'].includes(id)).map(([id]) => id),
      'ice',
      'ice-cubes',
    ],
  );

  const orderId = db
    .prepare(
      "INSERT INTO orders (order_number, type, status) VALUES ('SORT-1', 'takeaway', 'pending')",
    )
    .run().lastInsertRowid;
  const insert = db.prepare(`INSERT INTO order_items
    (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status)
    VALUES (?, ?, ?, 50, ?, ?, ?, 'pending')`);
  for (const item of lines)
    insert.run(orderId, item.product_id, item.product_name, item.quantity, item.total, item.total);
  const billOrder = getOrderWithItems(db, Number(orderId));
  assert.deepEqual(
    billOrder.items.map((item: { product_id: string }) => item.product_id),
    expected,
  );
  assert.equal(
    billOrder.items.reduce((sum: number, item: { total: number }) => sum + item.total, 0),
    lines.reduce((sum, item) => sum + item.total, 0),
  );
  console.log('Bill items: food first, drinks next, ice last; stable order and amounts preserved.');
} finally {
  closeDatabase();
}
