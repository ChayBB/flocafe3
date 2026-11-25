import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// The Cloud QR page as `scripts/build-cloud-ordering.cjs` emits it, with the Cloud API mocked.
const bundle = path.resolve(__dirname, '../../dist/cloud-ordering');
const TABLE = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const TOKEN = 'B'.repeat(43);
const STAFF_URL = 'http://staff.flo.test/server-standalone/';
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

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

async function openServiceMenu(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/menu-presentation.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ categories: [], products: [], popular: [], staffUrl: STAFF_URL }),
    }),
  );
  await page.route(`${STAFF_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Staff area</h1>' }),
  );
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    switch (new URL(route.request().url()).pathname) {
      case '/api/v1/table-qr/session':
        return json({ table_token: TOKEN });
      case '/api/v1/menu':
        return json({
          items: [],
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
  await page.getByTestId('server-app-header-grid-circle').click();
  const menu = page.getByTestId('service-menu');
  await expect(menu).toContainText('แตะแถบสีเทาด้านบน 3 ครั้งภายใน 1.5 วินาที หรือกดค้าง 3 วินาที');
  await menu.screenshot({ path: test.info().outputPath('cloud-service-menu.png') });
  return menu.getByTestId('service-menu-staff-handle');
}

test('three quick taps on the grey bar unlock the staff area', async ({ page }) => {
  const handle = await openServiceMenu(page);
  await handle.click();
  await handle.click();
  await expect(page).toHaveURL(new RegExp(`^${origin}/`));
  await handle.click();
  await page.getByTestId('service-menu-staff-area').click();
  await expect(page).toHaveURL(`${STAFF_URL}?staff=area`);
});

test('only a three-second hold on the grey bar unlocks the staff area', async ({ page }) => {
  const handle = await openServiceMenu(page);
  await handle.hover();
  await page.mouse.down();
  await page.waitForTimeout(2000);
  await page.mouse.up();
  const staffArea = page.getByTestId('service-menu-staff-area');
  await expect(staffArea).toHaveCount(0);
  await page.waitForTimeout(1600);
  await page.mouse.down();
  await page.waitForTimeout(3300);
  await page.mouse.up();
  await staffArea.click();
  await expect(page).toHaveURL(`${STAFF_URL}?staff=area`);
});
