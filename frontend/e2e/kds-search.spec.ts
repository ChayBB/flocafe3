import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};
const serverHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
};

async function makeProduct(page: Page, name: string) {
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers: managerHeaders,
    data: { name: `Cat ${Math.random().toString(36).slice(2, 7)}` },
  });
  expect(category.status()).toBe(201);
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers: managerHeaders,
    data: {
      name,
      category_id: (await category.json()).category.id,
      price: 50,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  return (await product.json()).product.id as string;
}

test('KDS search filters tickets by menu item, table, server and order number, and clearing restores them', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = Math.random().toString(36).slice(2, 7);
  const dineInDish = `ผัดไทยกุ้ง Search ${run}`;
  const takeawayDish = `Basil takeaway ${run}`;
  const lateDish = `Late arrival ${run}`;
  const tableLabel = `Srch${run}`;
  const dineInProduct = await makeProduct(page, dineInDish);
  const takeawayProduct = await makeProduct(page, takeawayDish);
  const lateProduct = await makeProduct(page, lateDish);

  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers: managerHeaders,
    data: { number: tableLabel, capacity: 2 },
  });
  expect(table.status()).toBe(201);
  const dineIn = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: serverHeaders,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [{ product_id: dineInProduct, quantity: 1 }],
    },
  });
  expect(dineIn.status()).toBe(201);
  const takeaway = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: managerHeaders,
    data: { type: 'takeaway', items: [{ product_id: takeawayProduct, quantity: 1 }] },
  });
  expect(takeaway.status()).toBe(201);
  const takeawayNumber = (await takeaway.json()).order.order_number as string;

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

  const search = page.getByTestId('kds-search-input');
  await expect(search).toHaveAttribute('placeholder', 'Search menu, table, server or order number');
  const dineInCard = page.getByText(dineInDish, { exact: true });
  const takeawayCard = page.getByText(takeawayDish, { exact: true });
  await expect(dineInCard).toBeVisible();
  await expect(takeawayCard).toBeVisible();

  // Menu item, matched case-insensitively.
  await search.fill(`ผัดไทยกุ้ง SEARCH ${run.toUpperCase()}`);
  await expect(dineInCard).toBeVisible();
  await expect(takeawayCard).toHaveCount(0);

  // A ticket arriving while the filter is on stays hidden until it matches.
  const late = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: managerHeaders,
    data: { type: 'takeaway', items: [{ product_id: lateProduct, quantity: 1 }] },
  });
  expect(late.status()).toBe(201);
  await search.fill(lateDish.toLowerCase());
  await expect(page.getByText(lateDish, { exact: true })).toBeVisible();
  await expect(dineInCard).toHaveCount(0);

  await search.fill(tableLabel.toLowerCase());
  await expect(dineInCard).toBeVisible();
  await expect(takeawayCard).toHaveCount(0);

  await search.fill('e2e SERVER');
  await expect(dineInCard).toBeVisible();
  await expect(takeawayCard).toHaveCount(0);

  await search.fill(`#${takeawayNumber}`);
  await expect(takeawayCard).toBeVisible();
  await expect(dineInCard).toHaveCount(0);

  await search.fill(`no such ticket ${run}`);
  await expect(page.getByTestId('kds-search-empty')).toContainText(
    `No tickets match “no such ticket ${run}”`,
  );
  await expect(dineInCard).toHaveCount(0);

  await page.getByTestId('kds-search-clear').click();
  await expect(search).toHaveValue('');
  await expect(page.getByTestId('kds-search-empty')).toHaveCount(0);
  await expect(dineInCard).toBeVisible();
  await expect(takeawayCard).toBeVisible();
  await expect(page.getByText(lateDish, { exact: true })).toBeVisible();

  await search.fill(tableLabel);
  await expect(takeawayCard).toHaveCount(0);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(takeawayCard).toBeVisible();
});
