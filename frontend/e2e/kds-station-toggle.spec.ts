import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test('KDS station picker shows one menu category and the item toggle advances its stage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);

  const makeProduct = async (label: string) => {
    const categoryName = `${label} ${run}`;
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

    const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
      headers,
      data: {
        name: `${label} dish ${run}`,
        category_id: categoryId,
        price: 50,
        tax_category_id: null,
        tax_behavior: 'exempt',
      },
    });
    expect(product.status()).toBe(201);
    return {
      categoryName,
      productId: (await product.json()).product.id,
      name: `${label} dish ${run}`,
    };
  };
  const grill = await makeProduct('Grill');
  const bar = await makeProduct('Bar');

  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'takeaway',
      items: [
        { product_id: grill.productId, quantity: 1 },
        { product_id: bar.productId, quantity: 1 },
      ],
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

  // The picker sits between the connection status and the view switch, opens on all stations,
  // and keeps "All stations" as its first option.
  const select = page.getByTestId('kds-station-select');
  await expect(select).toBeVisible();
  const selectBox = (await select.boundingBox())!;
  expect(selectBox.x).toBeGreaterThan(
    (await page.getByText('Live', { exact: true }).boundingBox())!.x,
  );
  expect(selectBox.x).toBeLessThan((await page.getByTestId('kds-fullscreen').boundingBox())!.x);
  await expect(select).toHaveValue('');
  await expect(select.locator('option').first()).toHaveText('All stations');
  await expect(select.locator('option', { hasText: grill.categoryName })).toHaveCount(1);

  await expect(page.getByText(grill.name)).toBeVisible();
  await expect(page.getByText(bar.name)).toBeVisible();
  const snapshot = page.waitForEvent('websocket').then(
    (socket) =>
      new Promise<{ orders: { items: { product_name: string }[] }[] }>((resolve) => {
        socket.on('framereceived', (frame) => {
          const message = JSON.parse(String(frame.payload));
          if (message.type === 'initial_data') resolve(message);
        });
      }),
  );
  await select.selectOption({ label: grill.categoryName });
  const received = await snapshot;
  expect(
    received.orders.flatMap((order: { items: { product_name: string }[] }) =>
      order.items.map((item: { product_name: string }) => item.product_name),
    ),
  ).toContain(grill.name);
  expect(
    received.orders.flatMap((order: { items: { product_name: string }[] }) =>
      order.items.map((item: { product_name: string }) => item.product_name),
    ),
  ).not.toContain(bar.name);
  const stationId = await select.inputValue();
  for (const endpoint of [
    `${E2E_BASE_URL}/api/kitchen/orders`,
    `${E2E_KDS_BASE_URL}/api/kds/orders`,
  ]) {
    const response = await page.request.get(
      `${endpoint}?station_id=${encodeURIComponent(stationId)}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(
      body.orders.flatMap((order: { items: { product_name: string }[] }) =>
        order.items.map((item: { product_name: string }) => item.product_name),
      ),
    ).toContain(grill.name);
    expect(
      body.orders.flatMap((order: { items: { product_name: string }[] }) =>
        order.items.map((item: { product_name: string }) => item.product_name),
      ),
    ).not.toContain(bar.name);
  }

  await expect(page.getByText(grill.name)).toBeVisible();
  await expect(page.getByText(bar.name)).toHaveCount(0);

  const grillRow = page
    .getByText(grill.name)
    .locator('xpath=ancestor::div[@data-testid="kds-item-row"][1]');
  // Tapping the item itself opens nothing; only the toggle changes status.
  await page.getByText(grill.name).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await grillRow.getByRole('button', { name: 'Move to Preparing' }).click();
  await expect(page.getByRole('heading', { name: 'Skip a stage?' })).toHaveCount(0);

  await expect
    .poll(async () => {
      const body = await (
        await page.request.get(`${E2E_BASE_URL}/api/orders/${created.id}`, { headers })
      ).json();
      return body.order.items.map((item: { product_id: string; status: string }) => [
        item.product_id,
        item.status,
      ]);
    })
    .toEqual(
      expect.arrayContaining([
        [grill.productId, 'preparing'],
        [bar.productId, 'pending'],
      ]),
    );

  // This tablet keeps its selected station after a reload.
  await page.reload();
  await expect(page.getByTestId('kds-station-select')).toHaveValue(stationId);
  await expect(page.getByText(bar.name)).toHaveCount(0);
  await page.getByTestId('kds-station-select').selectOption('');
  await expect(page.getByText(bar.name)).toBeVisible();
});
