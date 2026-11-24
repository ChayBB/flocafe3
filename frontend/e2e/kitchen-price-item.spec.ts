import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
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

  const tableResponse = await page.request.post(`${BASE}/api/tables`, {
    headers,
    data: { number: `Price ${run}`, capacity: 2 },
  });
  expect(tableResponse.status()).toBe(201);
  const tableId = (await tableResponse.json()).table.id;
  const order = await page.request.post(`${BASE}/api/orders`, {
    headers,
    data: { type: 'dine_in', table_id: tableId, items: [{ product_id: productId, quantity: 1 }] },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;
  const line = created.items[0];
  expect(line.pending_price_mode).toBe('kitchen_price');
  expect(line.special_instructions).toContain('เมนูพิเศษครัวระบุราคา');

  const kdsPage = await page.context().newPage();
  await kdsPage.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    kdsPage.getByTestId('kds-login-form').or(kdsPage.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await kdsPage.getByTestId('kds-login-form').isVisible()) {
    await kdsPage.getByTestId('kds-login-email').fill('manager@flo.local');
    await kdsPage.getByTestId('kds-login-password').fill(E2E_PASSWORD);
    await kdsPage.getByTestId('kds-login-submit').click();
  }
  const card = kdsPage.locator('div.select-none').filter({ hasText: `#${created.order_number}` });
  await expect(card.getByTestId('kds-price-waiting')).toBeVisible();
  await expect(card.getByTestId('kds-price-approval-hint')).toBeVisible();
  await expect(card.locator('[data-kitchen-price-card]')).toHaveAttribute(
    'data-kitchen-price-card',
    'waiting',
  );
  await expect(card.getByTestId('kds-set-price')).toHaveCount(0);
  for (const control of ['kds-price-waiting', 'kds-out-of-stock-button']) {
    await card.getByTestId(control).click();
    const dialog = kdsPage.getByTestId('kds-price-dialog');
    await expect(dialog.getByTestId('kds-price-input')).toBeVisible();
    await kdsPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }

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
  // An older POS backend may still return these fields during a rolling update.
  await page.route('**/api/guest-alerts', (route) =>
    route.fulfill({
      json: {
        alerts: [],
        price_alerts: [{ id: 1, table: '26', item: 'Chef special', weight: null, price: 359 }],
        currency: 'THB',
      },
    }),
  );
  const posAlerts = page.waitForResponse((response) =>
    response.url().endsWith('/api/guest-alerts'),
  );
  await page.goto(`${BASE}/pos`);
  await posAlerts;
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  await expect(page.getByTestId('staff-price-alert')).toHaveCount(0);

  const price = card.getByTestId('kds-set-price');
  await expect(price).toContainText('359');
  await expect(card.getByTestId('kds-price-waiting')).toHaveCount(0);
  await expect(card.locator('[data-kitchen-price-card]')).toHaveAttribute(
    'data-kitchen-price-card',
    'priced',
  );
  await expect(price).toHaveClass(/text-green-600/);
  await expect(card).not.toContainText('เมนูพิเศษครัวระบุราคา');

  const approvalBadge = card.getByTestId('kds-price-approved');
  const approvalHint = card.getByTestId('kds-price-approval-hint');
  await expect(approvalBadge).toHaveCount(0);
  await expect(approvalHint).toBeVisible();
  const staffHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
  };
  const tables = await (
    await page.request.get(`${E2E_SERVER_APP_BASE_URL}/api/tables`, { headers: staffHeaders })
  ).json();
  const tablePrice = tables.tables
    .find((table: { id: string }) => table.id === tableId)
    .table_price_items.find((item: { id: number }) => item.id === line.id);
  const approval = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${created.id}/items/${line.id}/approve-kitchen-price`,
    { headers: staffHeaders, data: { price_entry_id: tablePrice.price_entry_id } },
  );
  expect(approval.ok()).toBe(true);
  await expect(approvalBadge).toHaveText('Price approved');
  await expect(approvalHint).toHaveCount(0);
  await expect(price).toContainText('359');

  // Repricing clears the old approval without reloading the KDS.
  for (const next of ['420', '450']) {
    await card.getByTestId('kds-out-of-stock-button').click();
    const dialog = kdsPage.getByTestId('kds-price-dialog');
    await expect(dialog.getByTestId('kds-price-input')).not.toHaveValue('');
    await dialog.getByTestId('kds-price-input').fill(next);
    await dialog.getByTestId('kds-price-save').click();
    await expect(dialog).toBeHidden();
    await expect(price).toContainText(next);
    await expect(approvalBadge).toHaveCount(0);
    await expect(approvalHint).toBeVisible();
  }
  const repriced = await (
    await page.request.get(`${BASE}/api/orders/${created.id}`, { headers })
  ).json();
  expect(repriced.order.total).toBe(450);
});

test('the KDS weighs a weight-priced dish from its quantity, and can weigh it again', async ({
  page,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const run = Math.random().toString(36).slice(2, 7);
  const group = await page.request.post(`${BASE}/api/addon-groups`, {
    headers,
    data: {
      name: `By weight ${run}`,
      is_required: false,
      price_pending: true,
      min_selection: 0,
      max_selection: 1,
      addons: [{ name: 'Weighed', price: 0 }],
    },
  });
  expect(group.status()).toBe(201);
  const categoryRes = await page.request.post(`${BASE}/api/categories`, {
    headers,
    data: { name: `Weighed ${run}` },
  });
  const product = await page.request.post(`${BASE}/api/products`, {
    headers,
    data: {
      name: `Fish ${run}`,
      category_id: (await categoryRes.json()).category.id,
      price: 250,
      tax_category_id: null,
      tax_behavior: 'exempt',
      addon_group_ids: [(await group.json()).addon_group.id],
    },
  });
  expect(product.status()).toBe(201);
  const order = await page.request.post(`${BASE}/api/orders`, {
    headers,
    data: {
      type: 'takeaway',
      items: [{ product_id: (await product.json()).product.id, quantity: 1 }],
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;
  expect(Boolean(created.items[0].weight_pending)).toBe(true);

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill(E2E_PASSWORD);
  await page.getByTestId('kds-login-submit').click();
  const card = page.locator('div.select-none').filter({ hasText: `#${created.order_number}` });
  const quantity = card.getByTestId('kds-out-of-stock-button');
  await expect(quantity).toHaveAttribute('data-price-entry', 'true');
  for (const [weight, total] of [
    ['0.4', 100],
    ['0.5', 125],
  ] as const) {
    await quantity.click();
    const dialog = page.getByTestId('kds-price-dialog');
    await dialog.getByTestId('kds-price-input').fill(weight);
    // The dialog works the price out like the cashier's: weight times the price per kg.
    const formula = dialog.getByTestId('kds-price-formula');
    await expect(formula).toContainText('Base price');
    await expect(formula).toContainText('250');
    await expect(formula).toContainText(`${Number(weight).toFixed(2)} kg ×`);
    await expect(formula).toContainText(String(total));
    await dialog.getByTestId('kds-price-save').click();
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId('kds-set-price')).toContainText(
      `${Number(weight).toFixed(2)} kg`,
    );
    const after = await (
      await page.request.get(`${BASE}/api/orders/${created.id}`, { headers })
    ).json();
    expect(after.order.total).toBe(total);
  }
});
