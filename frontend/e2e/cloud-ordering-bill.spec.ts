import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// The Cloud QR page as `scripts/build-cloud-ordering.cjs` emits it, with the Cloud API mocked.
const bundle = path.resolve(__dirname, '../../dist/cloud-ordering');
const TABLE = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const TOKEN = 'T'.repeat(43);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
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

test('a Cloud QR guest sees the POS bill, asks for it and can no longer order', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let requested = false;
  const billRequests: string[] = [];
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
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
        });
      case '/api/v1/table-session/orders':
        return json({
          table_name: 'A1',
          bill_awaiting_payment: false,
          bill_requested: requested,
          as_of: '2026-11-22T05:30:00.000Z',
          orders: [
            {
              id: 'cloud-order-1',
              status: 'pos_accepted',
              pos_order_number: 'ORD-7',
              items: [
                {
                  name: 'Pad Thai',
                  quantity: 2,
                  addons: [],
                  status: 'preparing',
                  total_satang: 24000,
                },
              ],
            },
          ],
          bill: {
            order_number: 'ORD-7',
            items: [
              {
                id: 11,
                product_id: 'p-pad-thai',
                product_name: 'Pad Thai',
                quantity: 2,
                status: 'preparing',
                total: 240,
                ordered_by: null,
                ordered_by_guest: true,
              },
              {
                id: 12,
                product_id: 'p-water',
                product_name: 'Water',
                quantity: 1,
                status: 'served',
                total: 20,
                ordered_by: 'Ann',
                ordered_by_guest: false,
              },
            ],
            bill: {
              subtotal: 260,
              discount_amount: 0,
              service_charge: 26,
              tax_amount: 0,
              tax_included: false,
              round_off: 0,
              total: 286,
            },
          },
        });
      case '/api/v1/table-session/bill-request':
        billRequests.push(route.request().headers().authorization ?? '');
        requested = true;
        return json({ ok: true });
      default:
        return json({ error: 'not mocked' }, 404);
    }
  });

  await page.goto(`${origin}/#table=${TABLE}`);
  await page.getByTestId('server-app-history-button').click();
  const history = page.getByTestId('server-app-guest-history');
  await expect(history).toBeVisible();
  // The POS bill, including a dish staff added, stands in for the guest's own Cloud orders.
  await expect(history.getByTestId('server-app-guest-history-item')).toHaveCount(2);
  await expect(history.getByTestId('server-app-guest-history-ordered-by')).toHaveText([
    /ลูกค้า/,
    /Ann/,
  ]);
  await expect(history.getByTestId('server-app-guest-history-as-of')).toContainText('12:30');

  await history.getByTestId('server-app-guest-bill-button').click();
  await expect(page.getByTestId('server-app-guest-bill-table')).toContainText('A1');
  await expect(page.getByTestId('server-app-guest-bill-total')).toContainText('286');
  await page.getByTestId('server-app-guest-pay-staff').click();
  await page.getByTestId('server-app-guest-bill-continue').click();

  const confirm = page.getByTestId('server-app-guest-bill-confirm');
  await expect(confirm).toContainText('ยืนยันการเรียกเช็คบิล');
  await confirm.getByTestId('server-app-guest-bill-confirm-cancel').click();
  await expect(confirm).toHaveCount(0);
  expect(billRequests).toHaveLength(0);

  await page.getByTestId('server-app-guest-bill-continue').click();
  await page.getByTestId('server-app-guest-bill-confirm-ok').click();
  const done = page.getByTestId('server-app-guest-bill-requested-modal');
  await expect(done).toContainText('เรียกเช็คบิลแล้ว');
  expect(billRequests).toEqual([`Bearer ${TOKEN}`]);
  await done.getByTestId('server-app-guest-bill-requested-ok').click();
  await expect(page.getByTestId('server-app-guest-bill-requested')).toBeVisible();
  await expect(page.getByTestId('server-app-guest-bill-continue')).toBeDisabled();

  await page.getByTestId('server-app-guest-bill-back').click();
  await page.getByTestId('server-app-guest-history-close').click();
  await expect(page.getByTestId('cloud-bill-lock')).toContainText(
    'เรียกเช็คบิลแล้ว โต๊ะนี้จึงสั่งอาหารเพิ่มไม่ได้',
  );

  // A reload keeps the request, from the Cloud's own record.
  await page.reload();
  await expect(page.getByTestId('cloud-bill-lock')).toBeVisible();
});
