import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// The Cloud QR page as `scripts/build-cloud-ordering.cjs` emits it, with the Cloud API mocked.
const bundle = path.resolve(__dirname, '../../dist/cloud-ordering');
const TABLE = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const TOKEN = 'B'.repeat(43);
const LOGO = `${'a'.repeat(64)}.png`;
const COVER = `${'c'.repeat(64)}.jpeg`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
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

async function openWithCloudBranding(page: Page, branding: unknown) {
  await page.setViewportSize({ width: 390, height: 844 });
  const images: string[] = [];
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/v1/menu-images/branding/')) {
      images.push(url.pathname.slice('/api/v1/menu-images/branding/'.length));
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    switch (url.pathname) {
      case '/api/v1/table-qr/session':
        return json({ table_token: TOKEN });
      case '/api/v1/menu':
        return json({
          items: [
            {
              id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
              name: 'Pad Thai',
              price_satang: 12000,
              category: 'Noodles',
            },
          ],
          menu_revision: '7c1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
          scroll_percent: 87,
          ...(branding === undefined ? {} : { branding }),
        });
      case '/api/v1/table-session/orders':
        return json({ orders: [], bill: null });
      default:
        return route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto(`${origin}/#table=${TABLE}`);
  await expect(page.getByText('Pad Thai').first()).toBeVisible();
  return images;
}

test('the Cloud QR header shows the logo and cover the POS last pushed', async ({ page }) => {
  const images = await openWithCloudBranding(page, { logo: LOGO, cover: COVER });
  await expect(page.getByTestId('server-app-header-logo')).toHaveAttribute(
    'src',
    `/api/v1/menu-images/branding/${LOGO}`,
  );
  await expect(page.getByTestId('server-app-header-cover')).toHaveAttribute(
    'src',
    `/api/v1/menu-images/branding/${COVER}`,
  );
  await expect.poll(() => images.sort()).toEqual([COVER, LOGO].sort());
});

test('a logo and cover cleared in the POS leave the default header', async ({ page }) => {
  await openWithCloudBranding(page, { logo: null, cover: null });
  await expect(page.getByTestId('server-app-header-logo')).toHaveCount(0);
  await expect(page.getByTestId('server-app-header-cover')).toHaveAttribute(
    'src',
    /server-app-cover\.jpg$/,
  );
});

test('before the POS has pushed branding the page keeps the files baked into the build', async ({
  page,
}) => {
  const baked = JSON.parse(fs.readFileSync(path.join(bundle, 'branding.json'), 'utf8'));
  await openWithCloudBranding(page, null);
  const logo = page.getByTestId('server-app-header-logo');
  if (baked.logo) await expect(logo).toHaveAttribute('src', new RegExp(`${baked.logo}$`));
  else await expect(logo).toHaveCount(0);
  if (baked.cover)
    await expect(page.getByTestId('server-app-header-cover')).toHaveAttribute(
      'src',
      new RegExp(`${baked.cover}$`),
    );
});
