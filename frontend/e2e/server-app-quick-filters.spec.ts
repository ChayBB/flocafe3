import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the search box shares the category row, followed by food, drinks, popular, recommended and promotion filters', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const base = await page.request.get(`${E2E_BASE_URL}/api/products/e2e-product`, { headers });
  const categoryId = (await base.json()).product.category_id;
  const create = async (name: string, tags: string[]) => {
    const res = await page.request.post(`${E2E_BASE_URL}/api/products`, {
      headers,
      data: { category_id: categoryId, name, price: 50, tags },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).product.id as string;
  };
  const sold = await create(`Sold ${run}`, []);
  await create(`Chef ${run}`, ['recommended']);
  await create(`Deal ${run}`, ['promotion']);
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: { type: 'takeaway', items: [{ product_id: sold, quantity: 40 }] },
  });
  expect(order.status()).toBe(201);
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: `Quick ${run}`, capacity: 2 },
  });
  expect(table.ok()).toBeTruthy();

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
  );
  await page.reload();
  await openServerAppTables(page);
  await page.getByRole('button', { name: new RegExp(`Quick ${run}`) }).click();

  const grid = page.getByTestId('pos-product-grid');
  const search = grid.getByTestId('pos-product-search');
  const menu = grid.getByTestId('pos-category-menu');
  const row = grid.getByTestId('pos-category-row');
  await expect(search).toBeVisible();
  const searchBox = (await search.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.x).toBeGreaterThan(searchBox.x + searchBox.width - 1);
  expect(rowBox.x).toBeGreaterThan(menuBox.x + menuBox.width - 1);
  expect(searchBox.width, 'an empty search is a round magnifier').toBeLessThan(48);
  expect(
    Math.abs(searchBox.y + searchBox.height / 2 - (rowBox.y + rowBox.height / 2)),
  ).toBeLessThan(12);
  expect(rowBox.x).toBeGreaterThan(searchBox.x + searchBox.width - 1);

  const chips = row.getByRole('button');
  await expect(chips.nth(0)).toHaveText('All');
  await expect(chips.nth(1)).toHaveText('Food');
  await expect(chips.nth(2)).toHaveText('Drinks');
  await expect(chips.nth(3)).toHaveText('Popular');
  await expect(chips.nth(4)).toHaveText('Recommended');
  await expect(chips.nth(5)).toHaveText('Promotions');

  const card = (name: string) => grid.getByRole('button', { name: new RegExp(`${name} ${run}`) });
  await grid.getByTestId('pos-quick-filter-recommended').click();
  await expect(grid.getByTestId('pos-quick-filter-recommended')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card('Chef')).toBeVisible();
  await expect(card('Deal')).toHaveCount(0);
  await expect(card('Sold')).toHaveCount(0);

  await grid.getByTestId('pos-quick-filter-promotion').click();
  await expect(card('Deal')).toBeVisible();
  await expect(card('Chef')).toHaveCount(0);

  await grid.getByTestId('pos-quick-filter-popular').click();
  await expect(card('Sold')).toBeVisible();
  await expect(card('Deal')).toHaveCount(0);

  // Food lists what sells, so the sold dish shows and the unsold ones do not.
  await grid.getByTestId('pos-quick-filter-food').click();
  await expect(card('Sold')).toBeVisible();
  await expect(card('Chef')).toHaveCount(0);

  // The menu lists only All and the quick filters, never the categories.
  await menu.click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'All',
    'Food',
    'Drinks',
    'Popular',
    'Recommended',
    'Promotions',
  ]);
  await page.getByRole('menuitem', { name: 'Recommended' }).click();
  await expect(grid.getByTestId('pos-quick-filter-recommended')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card('Chef')).toBeVisible();

  await chips.nth(0).click();
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await search.fill(run);
  await expect(card('Sold')).toBeVisible();
  await expect(card('Chef')).toBeVisible();
  await expect(card('Deal')).toBeVisible();
});
