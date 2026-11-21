import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('the sold-by-weight tab lists weight-priced menu items and saves a new price', async ({
  page,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const run = Math.random().toString(36).slice(2, 7);
  const name = `Weighdish ${run}`;
  const product = await page.request.post(`${BASE}/api/products`, {
    headers,
    data: { name, price: 350, sale_unit: 'kg', allow_fractional_quantity: true },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id as string;
  const price = async () =>
    (
      (await (await page.request.get(`${BASE}/api/products/sold-by-weight`, { headers })).json())
        .products as Array<{ id: string; price: number }>
    ).find((p) => p.id === productId)?.price;

  try {
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${BASE}/products`);

    await page.getByRole('tab', { name: 'Sold by weight' }).click();
    await expect(page).toHaveURL(/tab=weight/);
    const list = page.getByTestId('sold-by-weight-list');
    await page.locator('#products-search').fill(name);
    const input = list.getByLabel(`Price ${name}`);
    await expect(input).toHaveValue('350');
    await expect(list.getByText('per kg', { exact: true })).toBeVisible();
    const save = list.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
    await input.fill('420.50');
    await save.click();
    await expect.poll(price).toBe(420.5);
    await expect(save).toBeDisabled();
  } finally {
    await page.request.delete(`${BASE}/api/products/${productId}`, { headers });
  }
});
