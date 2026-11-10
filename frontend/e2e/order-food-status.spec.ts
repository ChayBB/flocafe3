import { test, expect } from '@playwright/test';
import { E2E_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('the order header shows how far its food has got, stage by stage, and each stage filters the items', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `Food ${run}`, capacity: 2 },
  });
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [1, 2, 3, 4].map((n) => ({
        product_id: 'e2e-product',
        quantity: 1,
        special_instructions: `${run} ${n}`,
      })),
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as {
    id: number;
    order_number: string;
    items: { id: number }[];
  };
  const moveTo = async (itemId: number, statuses: string[]) => {
    for (const status of statuses) {
      const res = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
        headers,
        data: { status },
      });
      expect(res.ok(), `item ${itemId} to ${status}`).toBeTruthy();
    }
  };
  await moveTo(created.items[1].id, ['preparing']);
  await moveTo(created.items[2].id, ['preparing', 'ready']);
  await moveTo(created.items[3].id, ['preparing', 'ready']);

  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${E2E_BASE_URL}/orders`);
  await page.getByText(created.order_number).first().click();

  const bar = page.getByTestId('order-food-status');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('order-food-status-pending')).toHaveText('Waiting1');
  await expect(page.getByTestId('order-food-status-preparing')).toHaveText('Preparing1');
  await expect(page.getByTestId('order-food-status-ready')).toHaveText('Ready2');
  await expect(page.getByTestId('order-food-status-served')).toHaveText('Served0');

  // Each stage is a link that narrows the item list; tapping it again shows everything.
  const items = page.getByTestId('order-detail-item');
  await expect(items).toHaveCount(4);
  const ready = page.getByTestId('order-food-status-ready');
  await ready.click();
  await expect(ready).toHaveAttribute('aria-pressed', 'true');
  await expect(items).toHaveCount(2);
  await page.getByTestId('order-food-status-pending').click();
  await expect(items).toHaveCount(1);
  await expect(items).toContainText(`${run} 1`);
  await page.getByTestId('order-food-status-pending').click();
  await expect(items).toHaveCount(4);
  await expect(page.getByTestId('order-food-status-served')).toBeDisabled();

  // The stage bar stays until every served dish is confirmed at the table.
  await moveTo(created.items[0].id, ['preparing', 'ready', 'served']);
  await moveTo(created.items[1].id, ['ready', 'served']);
  await moveTo(created.items[2].id, ['served']);
  await moveTo(created.items[3].id, ['served']);
  await page.reload();
  await page.getByText(created.order_number).first().click();
  await expect(page.getByTestId('order-food-status-served')).toHaveText('Served4');
  const partial = await page.request.post(
    `${E2E_BASE_URL}/api/orders/${created.id}/items/confirm-served`,
    { headers, data: { item_ids: [created.items[0].id] } },
  );
  expect(partial.ok(), await partial.text()).toBeTruthy();
  await page.reload();
  await page.getByText(created.order_number).first().click();
  await expect(bar).toBeVisible();
  const confirmed = await page.request.post(
    `${E2E_BASE_URL}/api/orders/${created.id}/items/confirm-served`,
    { headers, data: { item_ids: created.items.slice(1).map((item) => item.id) } },
  );
  expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
  await page.reload();
  await page.getByText(created.order_number).first().click();
  await expect(bar).toHaveCount(0);
  await expect(items).toHaveCount(4);
  // The order list still shows the serving confirmation.
  const row = page
    .getByRole('button')
    .filter({ hasText: `#${created.order_number}` })
    .first();
  await expect(row.getByTestId('order-status-badge')).toContainText('Pending');
  await expect(row.getByTestId('order-status-served-confirmed')).toBeVisible();
});
