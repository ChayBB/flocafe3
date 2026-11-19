import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the kitchen taps a dish quantity to flag it out of stock and the table staff are asked to cancel it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const tableName = `Stock ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: tableName, capacity: 2 },
  });
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [
        { product_id: 'e2e-product', quantity: 1 },
        { product_id: 'e2e-product', quantity: 2, special_instructions: `keep ${run}` },
      ],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;
  const [flaggedItem, keptItem] = created.items as { id: number }[];

  // A dish already cooking can still run out, and cancelling it must stay possible.
  const cooking = await page.request.patch(
    `${E2E_BASE_URL}/api/kds/items/${flaggedItem.id}/status`,
    { headers, data: { status: 'preparing' } },
  );
  expect(cooking.ok()).toBe(true);

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  const cardIn = (column: string) =>
    page
      .getByTestId(`kds-column-${column}`)
      .locator('div.rounded-xl')
      .filter({ hasText: `#${created.order_number}` });
  const firstRow = cardIn('preparing').getByTestId('kds-item-row');
  // Only waiting and cooking dishes offer it; the quantity is the button.
  await expect(firstRow.getByTestId('kds-out-of-stock-button')).toHaveText('1×');
  await expect(firstRow.getByTestId('kds-status-toggle')).toBeVisible();
  await firstRow.getByTestId('kds-out-of-stock-button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Out of stock', exact: true }).click();
  await expect(firstRow.getByTestId('kds-out-of-stock-badge')).toBeVisible();
  await expect(firstRow).toHaveAttribute('data-out-of-stock', 'true');
  await expect(cardIn('pending').getByTestId('kds-item-row')).not.toHaveAttribute(
    'data-out-of-stock',
    'true',
  );

  // The flagged dish is held where it is until the guest's cancellation.
  await expect(firstRow.getByTestId('kds-status-toggle')).toHaveCount(0);
  const advance = await page.request.patch(
    `${E2E_BASE_URL}/api/kds/items/${flaggedItem.id}/status`,
    { headers, data: { status: 'ready' } },
  );
  expect(advance.status()).toBe(409);

  const tables = await page.request.get(`${E2E_BASE_URL}/api/tables`, { headers });
  const flagged = (
    (await tables.json()).tables as {
      number: string;
      activeOrder?: { out_of_stock_items?: unknown[] };
    }[]
  ).find((row) => row.number === tableName);
  expect(flagged?.activeOrder?.out_of_stock_items).toEqual([
    expect.objectContaining({ id: flaggedItem.id, product_name: 'E2E Coffee', quantity: 1 }),
  ]);

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, managerToken],
  );
  await page.reload();
  const alert = page
    .getByTestId('out-of-stock-alert')
    .filter({ hasText: `Table ${tableName}: E2E Coffee is out of stock, please cancel` });
  await expect(alert).toBeVisible();
  await alert.click();
  const orderedItems = page.getByTestId('server-app-ordered-items');
  await expect(orderedItems.getByTestId('server-app-out-of-stock-tag')).toHaveCount(1);

  // Cancelling the dish with the guest ends the request.
  const flaggedRow = orderedItems
    .getByTestId('server-app-ordered-item')
    .filter({ has: page.getByTestId('server-app-out-of-stock-tag') });
  await expect(flaggedRow).toHaveAttribute('data-out-of-stock', 'true');
  await expect(flaggedRow).toHaveClass(/bg-orange-100/);
  await flaggedRow.getByTestId('server-app-item-menu').click();
  await expect(page.getByRole('menuitem')).toHaveText(['Cancel item']);
  await page.getByRole('menuitem', { name: 'Cancel item' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel item' }).click();
  await expect(alert).toHaveCount(0);
  const after = await (
    await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
  ).json();
  const kept = after.order.items.find((item: { id: number }) => item.id === keptItem.id);
  expect(kept.out_of_stock_at ?? null).toBeNull();
});
