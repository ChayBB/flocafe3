import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test('KDS settings switch columns off so the remaining ones sit together and items skip ahead', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);

  const categoryName = `Drinks ${run}`;
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: categoryName },
  });
  expect(category.status()).toBe(201);
  const stationCategoryId = (await category.json()).category.id;
  expect(
    (
      await page.request.post(`${E2E_BASE_URL}/api/kitchen-stations`, {
        headers,
        data: { name: categoryName, category_ids: [stationCategoryId] },
      })
    ).status(),
  ).toBe(201);

  const productName = `Iced tea ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'takeaway',
      items: [{ product_id: (await product.json()).product.id, quantity: 1 }],
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

  // The gear sits just before logout and opens the column switches for every stage.
  const gear = page.getByTestId('kds-settings-button');
  const gearBox = (await gear.boundingBox())!;
  expect(gearBox.x).toBeGreaterThan(
    (await page.getByRole('button', { name: 'Kanban' }).boundingBox())!.x,
  );
  expect(gearBox.x).toBeLessThan(
    (await page.getByTitle('Logout', { exact: true }).boundingBox())!.x,
  );
  await gear.click();
  const dialog = page.getByTestId('kds-settings-dialog');
  await expect(dialog).toContainText(categoryName);
  for (const stage of ['pending', 'preparing', 'ready', 'served']) {
    await expect(dialog.getByTestId(`kds-stage-switch-${stage}`)).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }
  await dialog.getByTestId('kds-stage-switch-preparing').click();
  await dialog.getByTestId('kds-stage-switch-ready').click();
  await expect(dialog.getByTestId('kds-stage-switch-preparing')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.keyboard.press('Escape');

  // Switched-off columns leave the board, so waiting and served sit side by side.
  await expect(page.getByTestId('kds-column-preparing')).toHaveCount(0);
  await expect(page.getByTestId('kds-column-ready')).toHaveCount(0);
  const waiting = (await page.getByTestId('kds-column-pending').boundingBox())!;
  const served = (await page.getByTestId('kds-column-served').boundingBox())!;
  expect(served.x - (waiting.x + waiting.width)).toBeLessThan(40);

  const row = page
    .getByText(productName)
    .locator('xpath=ancestor::div[@data-testid="kds-item-row"][1]');
  await row.getByRole('button', { name: 'Move to Delivered' }).click();
  await expect
    .poll(async () => {
      const body = await (
        await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
      ).json();
      return body.order.items[0].status;
    })
    .toBe('served');

  // The last column in use cannot be switched off.
  await gear.click();
  await dialog.getByTestId('kds-stage-switch-pending').click();
  await expect(dialog.getByTestId('kds-stage-switch-served')).toBeDisabled();
  await dialog.getByTestId('kds-stage-switch-pending').click();
  await page.keyboard.press('Escape');

  // The choice stays for this station after a reload; other stations keep every column.
  await page.reload();
  await page.getByTestId('kds-station-select').selectOption({ label: categoryName });
  await expect(page.getByTestId('kds-column-preparing')).toHaveCount(0);
  await page.getByTestId('kds-station-select').selectOption({ label: 'All stations' });
  await expect(page.getByTestId('kds-column-preparing')).toHaveCount(1);
});
