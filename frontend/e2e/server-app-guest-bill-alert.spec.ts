import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('a guest asking for the bill alerts the table staff, who bring the bill from the alert', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const tableName = `Bill ${Math.random().toString(36).slice(2, 7)}`;
  const table = (
    await (
      await page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableName, capacity: 2 },
      })
    ).json()
  ).table as { id: string };
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: table.id,
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { id: number };

  const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
    headers,
  });
  const token = new URL((await qr.json()).url as string).searchParams.get('t');
  const joined = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/join`, {
    data: { table_id: table.id, table_token: token },
  });
  const device = (await joined.json()).device_token as string;
  const asked = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/bill-request`, {
    data: { table_id: table.id, device_token: device },
  });
  expect(asked.ok()).toBeTruthy();

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, value]) => {
      localStorage.setItem(key, value);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, managerToken],
  );
  await page.reload();

  const alert = page
    .getByTestId('guest-bill-alert')
    .filter({ hasText: `Table ${tableName} asked for the bill` });
  await expect(alert).toBeVisible();
  await expect(
    page.getByTestId('server-app-table-picker').getByRole('button').filter({ hasText: tableName }),
  ).toContainText('Guest asked for the bill');

  // The alert opens the table's dishes, where staff confirm serving and print the bill.
  await alert.click();
  const orderedItems = page.getByTestId('server-app-ordered-items');
  await expect(orderedItems).toBeVisible();
  await orderedItems.getByTestId('server-app-print-bill').click();
  await expect(alert).toHaveCount(0);

  const after = await (
    await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
  ).json();
  expect(after.order.bill_requested_by).toBe('e2e-manager');
  expect(after.order.bill_requested_at).toBeTruthy();
});
