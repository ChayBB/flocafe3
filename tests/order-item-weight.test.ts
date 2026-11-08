/**
 * Weight-priced order lines: products linked to the "ราคาตามน้ำหนัก" add-on group
 * start as waiting for a weight, and weighing prices them at base price x weight.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-item-weight.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-item-weight-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-item-weight';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { WEIGHT_PENDING_NOTE, KITCHEN_PRICE_NOTE } = require('../main/lib/weight-pending');
const { billRoutes } = require('../main/routes/bills');
const { annotateKdsItems } = require('../main/db');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Weight-priced order lines');
  console.log('='.repeat(60));
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-w', 'Weighed', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-tofu', 'cat-w', 'Fried tofu', 250, 'none', 1, 1, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-plain', 'cat-w', 'Plain item', 100, 'none', 1, 2, ?, ?)`).run(now(), now());
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active, created_at, updated_at)
     VALUES ('ag-weight', ' ราคาตามน้ำหนัก ', 0, 0, 10, 0, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('ag-weight', 'prod-tofu')`,
  ).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-fish', 'cat-w', 'Steamed fish', 400, 'none', 1, 3, ?, ?)`).run(now(), now());
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, price_pending, min_selection, max_selection, allow_multiple_quantities, is_active, created_at, updated_at)
     VALUES ('ag-market', 'Market price', 0, 1, 0, 10, 0, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('ag-market', 'prod-fish')`,
  ).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
    VALUES ('prod-special', 'cat-w', 'Chef special', 0, 'none', 1, 4, ?, ?)`).run(now(), now());
  db.prepare(
    `INSERT INTO addon_groups (id, name, is_required, kitchen_price, min_selection, max_selection, allow_multiple_quantities, is_active, created_at, updated_at)
     VALUES ('ag-chef', 'Chef choice', 0, 1, 0, 10, 0, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('ag-chef', 'prod-special')`,
  ).run();

  const cashierAuth = seedUser(db, 'cashier-weight', 'cashier');
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);

  const itemsOf = (orderId: any) =>
    db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId) as any[];
  const orderRow = (orderId: any) =>
    db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
  const weigh = (orderId: any, itemId: any, weight: unknown) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/weight`, {
      method: 'PATCH',
      headers: cashierAuth,
      body: { weight },
    });

  try {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: cashierAuth,
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-tofu', quantity: 1 },
          { product_id: 'prod-plain', quantity: 2 },
        ],
      },
    });
    assertEqualOrThrow(created.status, 201, `order is created (${JSON.stringify(created.data)})`);
    const orderId = created.data.order.id;
    const [tofu, plain] = itemsOf(orderId);
    assertEqualOrThrow(tofu.weight_pending, 1, 'weight-priced line starts waiting for a weight');
    assertEqualOrThrow(tofu.weight, null, 'weight-priced line has no weight yet');
    assertEqualOrThrow(
      tofu.special_instructions,
      WEIGHT_PENDING_NOTE,
      'weight-priced line carries the kitchen note',
    );
    assertEqualOrThrow(plain.special_instructions, null, 'ordinary line has no note');

    await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: cashierAuth,
      body: { order_id: orderId },
    });
    const pendingBill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(orderId) as any;
    assertOrThrow(Boolean(pendingBill), 'order has a bill to test against');
    const blocked = [
      ['POST', `/api/bills/${pendingBill.id}/payment`, { method: 'cash', amount: 450 }],
      [
        'POST',
        `/api/bills/${pendingBill.id}/payments`,
        { payments: [{ method: 'cash', amount: 450 }] },
      ],
      ['POST', `/api/bills/${pendingBill.id}/print`, { print_type: 'receipt' }],
      ['POST', `/api/bills/${pendingBill.id}/markPrinted`, {}],
    ] as const;
    for (const [method, url, body] of blocked) {
      const response = await api(baseUrl, url, { method, headers: cashierAuth, body });
      assertEqualOrThrow(response.status, 409, `${url} is blocked while waiting for a weight`);
      assertEqualOrThrow(response.data.code, 'weight_pending', `${url} reports weight_pending`);
    }
    assertEqualOrThrow(plain.weight_pending, 0, 'ordinary line is not waiting for a weight');

    const plainAttempt = await weigh(orderId, plain.id, 0.5);
    assertEqualOrThrow(plainAttempt.status, 409, 'ordinary line cannot be weighed');

    for (const bad of [0, -1, 'abc', 0.0005, 0.299, 5000, 100.001]) {
      const response = await weigh(orderId, tofu.id, bad);
      assertEqualOrThrow(response.status, 400, `invalid weight ${String(bad)} is rejected`);
    }

    const weighed = await weigh(orderId, tofu.id, 0.35);
    assertEqualOrThrow(weighed.status, 200, `weighing succeeds (${JSON.stringify(weighed.data)})`);
    const after = itemsOf(orderId)[0];
    assertEqualOrThrow(after.weight_pending, 0, 'weighed line is no longer pending');
    assertEqualOrThrow(
      after.special_instructions,
      null,
      'weighing drops the waiting note; the KDS shows the price instead',
    );
    const [annotated] = annotateKdsItems(db, [{ items: [{ id: tofu.id }] }])[0].items;
    assertEqualOrThrow(annotated.kitchen_set_price, 87.5, 'the KDS item carries the weighed price');
    const [plainAnnotated] = annotateKdsItems(db, [{ items: [{ id: plain.id }] }])[0].items;
    assertEqualOrThrow(
      plainAnnotated.kitchen_set_price,
      null,
      'an ordinary line has no kitchen-set price',
    );
    assertEqualOrThrow(after.weight, 0.35, 'weight is stored on the line');
    assertEqualOrThrow(after.unit_price, 87.5, 'unit price is base price x weight');
    assertEqualOrThrow(after.quantity, 1, 'quantity stays 1');
    assertEqualOrThrow(after.total, 87.5, 'line total follows the weighed price');
    assertEqualOrThrow(orderRow(orderId).subtotal, 287.5, 'order subtotal is recomputed');
    assertEqualOrThrow(orderRow(orderId).total, 287.5, 'order total is recomputed');
    const responseItem = weighed.data.order.items.find((i: any) => i.id === tofu.id);
    assertEqualOrThrow(responseItem.weight_pending, 0, 'response carries the weighed line');

    const again = await weigh(orderId, tofu.id, 0.5);
    assertEqualOrThrow(again.status, 409, 'a weighed line cannot be weighed twice');

    const audit = db
      .prepare(
        "SELECT details_json FROM order_audit_log WHERE order_item_id = ? AND action = 'item_weighed'",
      )
      .get(String(tofu.id)) as any;
    assertOrThrow(Boolean(audit), 'weighing is recorded in the order audit log');
    assertEqualOrThrow(JSON.parse(audit.details_json).weight, 0.35, 'audit records the weight');

    const added = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: cashierAuth,
      body: { items: [{ product_id: 'prod-tofu', quantity: 1 }] },
    });
    assertOrThrow(added.status < 300, `items are added (${JSON.stringify(added.data)})`);
    const addedLine = itemsOf(orderId).at(-1);
    assertEqualOrThrow(
      addedLine.weight_pending,
      1,
      'an added weight-priced line waits for a weight',
    );

    const paidOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: cashierAuth,
      body: { type: 'takeaway', items: [{ product_id: 'prod-tofu', quantity: 1 }] },
    });
    const paidOrderId = paidOrder.data.order.id;
    const paidItem = itemsOf(paidOrderId)[0];
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES ('BILL-W-PAID', ?, 250, 250, 250, 0, 'paid', ?, ?)`).run(paidOrderId, now(), now());
    const paidAttempt = await weigh(paidOrderId, paidItem.id, 0.4);
    assertEqualOrThrow(paidAttempt.status, 409, 'a line on a paid order cannot be weighed');

    // A group flagged "awaiting price" behaves like the weight-priced group, whatever its name.
    const market = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: cashierAuth,
      body: { type: 'takeaway', items: [{ product_id: 'prod-fish', quantity: 1 }] },
    });
    assertEqualOrThrow(market.status, 201, 'an order with an awaiting-price item is created');
    const fishLine = itemsOf(market.data.order.id)[0];
    assertEqualOrThrow(
      fishLine.weight_pending,
      1,
      'an awaiting-price line waits like a weight-priced one',
    );
    assertEqualOrThrow(
      fishLine.special_instructions,
      WEIGHT_PENDING_NOTE,
      'it carries the same kitchen note',
    );
    const weighedFish = await weigh(market.data.order.id, fishLine.id, 0.5);
    assertEqualOrThrow(
      weighedFish.status,
      200,
      'an awaiting-price line is completed through the same flow',
    );
    assertEqualOrThrow(
      itemsOf(market.data.order.id)[0].unit_price,
      200,
      'its price follows the same calculation',
    );

    // A "kitchen sets the price" group waits for a set price that is stored exactly as entered.
    const special = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: cashierAuth,
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-special', quantity: 2, special_instructions: 'no chilli' }],
      },
    });
    assertEqualOrThrow(special.status, 201, 'an order with a kitchen-priced item is created');
    const specialOrderId = special.data.order.id;
    const specialLine = itemsOf(specialOrderId)[0];
    assertEqualOrThrow(
      specialLine.weight_pending,
      1,
      'a kitchen-priced line waits like a weight-priced one',
    );
    assertEqualOrThrow(
      specialLine.pending_price_mode,
      'kitchen_price',
      'the line records how it gets its price',
    );
    assertEqualOrThrow(
      specialLine.special_instructions,
      `${KITCHEN_PRICE_NOTE} | no chilli`,
      'the kitchen-price note is written into the special instructions automatically',
    );
    const specialBill = db
      .prepare('SELECT id FROM bills WHERE order_id = ?')
      .get(specialOrderId) as any;
    if (specialBill) {
      const blocked = await api(baseUrl, `/api/bills/${specialBill.id}/markPrinted`, {
        method: 'POST',
        headers: cashierAuth,
      });
      assertEqualOrThrow(blocked.status, 409, 'billing is blocked until the kitchen price is in');
    }
    const wrongRoute = await weigh(specialOrderId, specialLine.id, 0.5);
    assertEqualOrThrow(wrongRoute.status, 409, 'a kitchen-priced line cannot be weighed');
    const setPrice = (price: unknown) =>
      api(baseUrl, `/api/orders/${specialOrderId}/items/${specialLine.id}/price`, {
        method: 'PATCH',
        headers: cashierAuth,
        body: { price },
      });
    for (const bad of [0, -5, 'abc', 12.345, 2_000_000]) {
      const response = await setPrice(bad);
      assertEqualOrThrow(response.status, 400, `kitchen price ${String(bad)} is rejected`);
    }
    const priced = await setPrice(359);
    assertEqualOrThrow(
      priced.status,
      200,
      `the kitchen price is saved (${JSON.stringify(priced.data)})`,
    );
    const pricedLine = itemsOf(specialOrderId)[0];
    assertEqualOrThrow(pricedLine.weight_pending, 0, 'the priced line is no longer pending');
    assertEqualOrThrow(
      pricedLine.unit_price,
      359,
      'the set price is stored as entered, with no weight calculation',
    );
    assertEqualOrThrow(pricedLine.weight, null, 'no weight is recorded');
    assertEqualOrThrow(
      pricedLine.total,
      718,
      'the line total is the set price times the sets ordered',
    );
    assertEqualOrThrow(
      pricedLine.special_instructions,
      'no chilli',
      'pricing drops the kitchen-price note',
    );
    const [pricedAnnotated] = annotateKdsItems(db, [{ items: [{ id: pricedLine.id }] }])[0].items;
    assertEqualOrThrow(
      pricedAnnotated.kitchen_set_price,
      359,
      'the KDS item carries the kitchen-set price',
    );
    assertEqualOrThrow(orderRow(specialOrderId).total, 718, 'the order total is recomputed');
    const pricedAgain = await setPrice(400);
    assertEqualOrThrow(pricedAgain.status, 409, 'a priced line cannot be priced twice');
    const plainPrice = await api(baseUrl, `/api/orders/${orderId}/items/${plain.id}/price`, {
      method: 'PATCH',
      headers: cashierAuth,
      body: { price: 10 },
    });
    assertEqualOrThrow(plainPrice.status, 409, 'an ordinary line cannot take a kitchen price');

    console.log('\nAll weight-priced order line checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
