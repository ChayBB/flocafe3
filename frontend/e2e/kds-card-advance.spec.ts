import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test('a KDS card with several dishes moves on in one tap, with its clock beside the table', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const categoryName = `Wok ${run}`;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: categoryName },
  });
  expect(category.status()).toBe(201);
  const categoryId = (await category.json()).category.id;
  expect(
    (
      await page.request.post(`${E2E_BASE_URL}/api/kitchen-stations`, {
        headers,
        data: { name: categoryName, category_ids: [categoryId] },
      })
    ).status(),
  ).toBe(201);
  const productIds: string[] = [];
  for (const name of [`Fried rice ${run}`, `Basil pork ${run}`, `Omelette ${run}`]) {
    const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
      headers,
      data: {
        name,
        category_id: categoryId,
        price: 50,
        tax_category_id: null,
        tax_behavior: 'exempt',
      },
    });
    expect(product.status()).toBe(201);
    productIds.push((await product.json()).product.id);
  }
  const tableName = `T${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: tableName, name: tableName, capacity: 4, floor: 'Ground' },
  });
  expect(table.ok()).toBeTruthy();
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: productIds.map((product_id) => ({ product_id, quantity: 1 })),
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });

  const pending = page.getByTestId('kds-column-pending');
  await expect(pending.getByTestId('kds-item-row')).toHaveCount(3);
  // The clock sits just after the table badge, leaving the corner for the card toggle.
  const clockBox = (await pending.getByTestId('kds-card-clock').boundingBox())!;
  const tableBox = (await pending.getByText(`Table ${tableName}`).boundingBox())!;
  expect(
    Math.abs(clockBox.y + clockBox.height / 2 - (tableBox.y + tableBox.height / 2)),
  ).toBeLessThan(6);
  expect(clockBox.x).toBeGreaterThan(tableBox.x + tableBox.width);
  const cardToggle = pending.getByTestId('kds-card-toggle');
  await expect(cardToggle).toHaveAccessibleName('Move all to Preparing');
  expect((await cardToggle.boundingBox())!.x).toBeGreaterThan(clockBox.x + clockBox.width);

  await cardToggle.click();
  await expect(pending.getByTestId('kds-item-row')).toHaveCount(0);
  await expect(page.getByTestId('kds-column-preparing').getByTestId('kds-item-row')).toHaveCount(3);
  await expect
    .poll(async () => {
      const body = await (
        await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
      ).json();
      return body.order.items.map((item: { status: string }) => item.status);
    })
    .toEqual(['preparing', 'preparing', 'preparing']);

  // A card with one dish keeps only the row toggle.
  await page
    .getByTestId('kds-column-preparing')
    .getByTestId('kds-item-row')
    .first()
    .getByRole('button', { name: 'Move to Ready' })
    .click();
  const ready = page.getByTestId('kds-column-ready');
  await expect(ready.getByTestId('kds-item-row')).toHaveCount(1);
  await expect(ready.getByTestId('kds-card-toggle')).toHaveCount(0);
  await expect(page.getByTestId('kds-column-preparing').getByTestId('kds-card-toggle')).toHaveCount(
    1,
  );
});
