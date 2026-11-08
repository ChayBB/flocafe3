import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the kitchen-priced group description becomes a box for what the guest wants to eat', async ({
  page,
}) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const hint = 'อยากกินอะไร สั่งมาได้เลยจัดให้หรอยๆ';

  const group = await page.request.post(`${E2E_BASE_URL}/api/addon-groups`, {
    headers,
    data: {
      name: `Chef order ${run}`,
      description: hint,
      kitchen_price: true,
      min_selection: 0,
      max_selection: 1,
      addons: [{ name: 'Chef pick', price: 0 }],
    },
  });
  expect(group.status()).toBe(201);
  const groupId = (await group.json()).addon_group.id;
  // A fresh category, so no other test's add-on groups ride along through the category.
  const categoryRes = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Plain ${run}` },
  });
  expect(categoryRes.status()).toBe(201);
  const categoryId = (await categoryRes.json()).category.id;
  const productName = `Anything ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: categoryId,
      price: 0,
      tax_category_id: null,
      tax_behavior: 'exempt',
      addon_group_ids: [groupId],
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id;
  try {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: `Wish ${run}`, capacity: 2 },
    });
    const tableId = (await table.json()).table.id;

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
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${tableId}`);

    const grid = page.getByTestId('pos-product-grid');
    await grid.getByTestId('pos-product-search').fill(productName);
    await grid.getByTestId('pos-product-card').filter({ hasText: productName }).click();

    const wish = page.getByTestId('kitchen-request-input');
    await expect(wish).toBeVisible();
    await expect(wish).toHaveAttribute('placeholder', hint);
    await expect(page.getByText(hint, { exact: true })).toHaveCount(0);
    await wish.fill('ปลากะพงนึ่งมะนาว');
    await page.getByRole('button', { name: /Add to Cart/ }).click();
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const orders = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableId, type: 'dine_in', per_page: 1 },
      })
    ).json();
    expect(orders.orders[0].items[0].special_instructions).toBe(
      'เมนูพิเศษครัวระบุราคา | ปลากะพงนึ่งมะนาว',
    );

    // Sending clears the table, so the next order starts by choosing one.
    await expect(page.locator('header')).toContainText('Select a table');

    // Items already sent sit under a "Sent to kitchen" heading that names the order.
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${tableId}`);
    const sent = page.getByTestId('server-app-sent-heading');
    await expect(sent).toContainText('Sent to kitchen');
    await expect(sent).toContainText(`#${orders.orders[0].order_number}`);
  } finally {
    const archived = await page.request.delete(`${E2E_BASE_URL}/api/products/${productId}`, {
      headers,
    });
    expect(archived.ok(), await archived.text()).toBeTruthy();
  }
});
