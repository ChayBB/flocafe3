import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// The Cloud QR page as `scripts/build-cloud-ordering.cjs` emits it, with the Cloud API and the
// baked menu presentation mocked.
const bundle = path.resolve(__dirname, '../../dist/cloud-ordering');
const TABLE = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const TOKEN = 'B'.repeat(43);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

const presentation = {
  categories: [
    { id: 'food', name: 'อาหารจานเดียว', parent_id: null, sort_order: 0, is_active: true },
    { id: 'pick', name: 'ตามใจฉัน', parent_id: null, sort_order: 1, is_active: true },
    { id: 'drinks', name: 'เครื่องดื่ม', parent_id: null, sort_order: 2, is_active: true },
  ].map((category) => ({ slug: '', description: null, color: null, icon: null, ...category })),
  products: [
    ['p-rice', 'ข้าวผัด', 'food'],
    ['p-pick', 'ตามใจฉัน', 'pick'],
    ['p-ice', 'น้ำแข็ง', 'drinks'],
    ['p-beer', 'เบียร์ลีโอ', 'drinks'],
    ['p-coke', 'โค๊ก', 'drinks'],
    ['p-water', 'น้ำเปล่า', 'drinks'],
    ['p-soda', 'โซดา', 'drinks'],
  ].map(([id, name, categoryId]) => ({ id, name, categoryId, tags: [], variants: [] })),
  popular: ['p-rice'],
};
const categoryName = new Map(presentation.categories.map((c) => [c.id, c.name]));
const items = presentation.products.map((product, index) => ({
  id: `0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c${String(index).padStart(2, '0')}`,
  name: product.name,
  price_satang: 5000,
  category: categoryName.get(product.categoryId) ?? null,
}));
const drinks = ['น้ำแข็ง', 'เบียร์ลีโอ', 'โค๊ก', 'น้ำเปล่า', 'โซดา'];

let server: http.Server;
let origin: string;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(bundle, 'index.html')))
    throw new Error(
      'Build the Cloud page first: FLO_E2E_DB_PATH=<test db> node scripts/build-cloud-ordering.cjs',
    );
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const file = path.join(bundle, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(bundle) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
});

test('the drinks chip lists every drink and no category chip repeats a quick filter', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/menu-presentation.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(presentation),
    }),
  );
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    switch (new URL(route.request().url()).pathname) {
      case '/api/v1/table-qr/session':
        return json({ table_token: TOKEN });
      case '/api/v1/menu':
        return json({
          items,
          menu_revision: '7c1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
          scroll_percent: 87,
        });
      case '/api/v1/table-session/orders':
        return json({ orders: [], bill: null });
      default:
        return route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto(`${origin}/#table=${TABLE}`);

  const grid = page.getByTestId('pos-product-grid');
  const row = grid.getByTestId('pos-category-row');
  const drinksChip = grid.getByTestId('pos-quick-filter-drinks');
  await expect(drinksChip).toBeVisible();
  await expect(row.getByRole('button', { name: 'อาหารจานเดียว' })).toBeVisible();

  const labels = (await row.getByRole('button').allTextContents()).map((text) => text.trim());
  expect(new Set(labels).size, `row chips repeat: ${labels.join(', ')}`).toBe(labels.length);
  await expect(row.locator('[data-chip-key="drinks"]'), 'the drinks category chip').toHaveCount(0);
  await expect(row.locator('[data-chip-key="pick"]'), 'the ตามใจฉัน category chip').toHaveCount(0);
  const drinksLabel = (await drinksChip.textContent())!.trim();
  expect(labels.filter((label) => label === drinksLabel)).toHaveLength(1);

  await drinksChip.click();
  await expect(drinksChip).toHaveAttribute('aria-pressed', 'true');
  const cards = grid.getByTestId('pos-product-card');
  await expect(cards).toHaveCount(drinks.length);
  for (const name of drinks) await expect(cards.filter({ hasText: name })).toHaveCount(1);
  await expect(cards.first()).toContainText('น้ำแข็ง');
  await expect(cards.filter({ hasText: 'ข้าวผัด' })).toHaveCount(0);
});
