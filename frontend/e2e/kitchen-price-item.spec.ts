import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

test('a special-menu item waits for the kitchen price and takes it as entered', async ({
  page,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const run = Math.random().toString(36).slice(2, 7);

  const group = await page.request.post(`${BASE}/api/addon-groups`, {
    headers,
    data: {
      name: `Chef choice ${run}`,
      is_required: false,
      kitchen_price: true,
      min_selection: 0,
      max_selection: 1,
      addons: [{ name: 'Chef pick', price: 0 }],
    },
  });
  expect(group.status()).toBe(201);
  const groupBody = (await group.json()).addon_group;
  expect(groupBody.kitchen_price).toBe(true);

  // A fresh category, so no other test's add-on groups ride along through the category.
  const categoryRes = await page.request.post(`${BASE}/api/categories`, {
    headers,
    data: { name: `Plain ${run}` },
  });
  expect(categoryRes.status()).toBe(201);
  const categoryId = (await categoryRes.json()).category.id;
  const product = await page.request.post(`${BASE}/api/products`, {
    headers,
    data: {
      name: `Chef special ${run}`,
      category_id: categoryId,
      price: 0,
      tax_category_id: null,
      tax_behavior: 'exempt',
      addon_group_ids: [groupBody.id],
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id;

  const order = await page.request.post(`${BASE}/api/orders`, {
    headers,
    data: { type: 'takeaway', items: [{ product_id: productId, quantity: 1 }] },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;
  const line = created.items[0];
  expect(line.pending_price_mode).toBe('kitchen_price');
  expect(line.special_instructions).toContain('เมนูพิเศษครัวระบุราคา');

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await page.goto(`${BASE}/orders`);

  await page.getByText(`#${created.order_number}`).first().click();
  await page.getByRole('button', { name: 'Awaiting kitchen price', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enter kitchen price' })).toBeVisible();
  await page.locator('#kitchen-price-input').fill('359');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enter kitchen price' })).toBeHidden();

  const after = await (
    await page.request.get(`${BASE}/api/orders/${created.id}`, { headers })
  ).json();
  const pricedLine = after.order.items.find((item: { id: number }) => item.id === line.id);
  expect(pricedLine.unit_price).toBe(359);
  expect(Boolean(pricedLine.weight_pending)).toBe(false);
  expect(after.order.total).toBe(359);

  // The KDS drops the waiting note and shows the kitchen-set price in green.
  expect(pricedLine.special_instructions).toBeNull();
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill(E2E_PASSWORD);
    await page.getByTestId('kds-login-submit').click();
  }
  const card = page.locator('div.select-none').filter({ hasText: `#${created.order_number}` });
  const price = card.getByTestId('kds-set-price');
  await expect(price).toContainText('359');
  await expect(price).toHaveClass(/text-green-600/);
  await expect(card).not.toContainText('เมนูพิเศษครัวระบุราคา');
});
