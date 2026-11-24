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
  const groupResponse = await page.request.post(`${E2E_BASE_URL}/api/addon-groups`, {
    headers,
    data: { name: `${tableName} kitchen price`, kitchen_price: true, addons: [] },
  });
  expect(groupResponse.status()).toBe(201);
  const groupId = (await groupResponse.json()).addon_group.id;
  const productResponse = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: `Chef special ${tableName}`,
      category_id: 'e2e-category',
      price: 0,
      tax_behavior: 'exempt',
      addon_group_ids: [groupId],
    },
  });
  expect(productResponse.status()).toBe(201);
  const productId = (await productResponse.json()).product.id;
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
      items: [{ product_id: productId, quantity: 1 }],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as {
    id: number;
    items: { id: number; pending_price_mode: string }[];
  };
  expect(created.items[0].pending_price_mode).toBe('kitchen_price');
  const savedPrice = await page.request.patch(
    `${E2E_BASE_URL}/api/kds/items/${created.items[0].id}/status`,
    { headers, data: { price: 375 } },
  );
  expect(savedPrice.ok()).toBe(true);

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

  const tablePicker = page.getByTestId('server-app-table-picker');
  const inlinePriceAlert = tablePicker
    .getByTestId('saved-price-alert')
    .filter({ hasText: tableName });
  const tableCard = tablePicker.getByRole('button').filter({ hasText: tableName });
  await expect(tableCard).toContainText('Price saved, tell the guest');
  await expect(inlinePriceAlert).toHaveCount(0);
  await expect(page.getByTestId('staff-price-alert').filter({ hasText: tableName })).toHaveCount(0);

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
  let finishPrint!: () => void;
  let printRequests = 0;
  const printPending = new Promise<void>((resolve) => {
    finishPrint = resolve;
  });
  await page.route('**/api/printers/print-bill', async (route) => {
    printRequests += 1;
    await printPending;
    await route.fulfill({ status: 502, json: { staff_print_locked: true } });
  });
  const printButton = orderedItems.getByTestId('server-app-print-bill');
  try {
    await printButton.click();
    await expect(printButton).toBeDisabled();
  } finally {
    finishPrint();
  }
  await expect(
    page
      .getByText("The cashier has been told, but the cashier's printer could not print the bill")
      .first(),
  ).toBeVisible();
  await expect(printButton).toBeDisabled();
  expect(printRequests).toBe(1);
  await expect(alert).toHaveCount(0);

  const after = await (
    await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
  ).json();
  expect(after.order.bill_requested_by).toBe('e2e-manager');
  expect(after.order.bill_requested_at).toBeTruthy();

  const assignment = await page.request.put(`${E2E_BASE_URL}/api/tables/${table.id}/owner`, {
    headers,
    data: { user_id: 'e2e-server' },
  });
  expect(assignment.ok()).toBe(true);
  const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
  await page.evaluate(([key, token]) => localStorage.setItem(key, token), [TOKEN_KEY, serverToken]);
  await page.reload();
  await expect(tableCard).toContainText('Price saved, tell the guest');
  await expect(inlinePriceAlert).toHaveCount(0);
  const repriced = await page.request.patch(
    `${E2E_BASE_URL}/api/kds/items/${created.items[0].id}/status`,
    { headers, data: { price: 385 } },
  );
  expect(repriced.ok()).toBe(true);
  await expect(inlinePriceAlert).toBeVisible({ timeout: 8_000 });
  await expect(inlinePriceAlert).toContainText(/Chef special.*385.*Please tell the guest/);
  await expect(inlinePriceAlert).toHaveCount(0, { timeout: 4_000 });
  await expect(tableCard).toContainText('Price saved, tell the guest');
  await tableCard.click();
  await orderedItems.getByTestId('server-app-item-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Cancel item' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Change to takeaway' })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Approve', exact: true }).click();
  await expect(tableCard).not.toContainText('Price saved, tell the guest');
  await page.reload();
  await expect(tableCard).toBeVisible();
  await expect(tableCard).not.toContainText('Price saved, tell the guest');
  await expect(inlinePriceAlert).toHaveCount(0);
  expect(
    (await page.request.delete(`${E2E_BASE_URL}/api/products/${productId}`, { headers })).ok(),
  ).toBe(true);
  expect(
    (await page.request.delete(`${E2E_BASE_URL}/api/addon-groups/${groupId}`, { headers })).ok(),
  ).toBe(true);
});
