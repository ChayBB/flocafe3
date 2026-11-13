import { test, expect, type Locator } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';

// When the KDS socket drops, the board falls back to REST polling while the closed
// socket stays referenced for reconnects. A successful tap must still refresh the
// board before the card is clickable again, or a cook re-taps a stale row and gets
// a 409 "Failed to update item" next to the success toast.
test('KDS REST fallback refreshes the board after a status tap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const loginRes = await page.request.post(`${E2E_BASE_URL}/api/auth/login`, {
    data: { email: 'manager@flo.local', password: 'E2ePass123!' },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { access_token } = await loginRes.json();

  const orderRes = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    data: { type: 'dine_in', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();
  const orderNumStr = `#${order.order_number}`;

  await page.routeWebSocket(/\/kds(\?.*)?$/, (ws) => {
    void ws.close();
  });

  const statusPatches: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/status$/.test(new URL(request.url()).pathname)) {
      statusPatches.push(request.url());
    }
  });

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
  await expect(page.getByTitle('REST polling (fallback)')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Polling 5s')).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Tabs', exact: true })).toHaveCount(0);

  const getColumn = (name: string) =>
    page
      .locator('div.flex-1.min-w-\\[260px\\]')
      .filter({ has: page.getByText(name, { exact: true }) })
      .getByTestId('kds-scroll-area');
  const waitingCol = getColumn('Waiting');
  const preparingCol = getColumn('Preparing');
  const cardIn = (col: Locator) =>
    col
      .locator('div.select-none.cursor-grab:not([data-dnd-placeholder])')
      .filter({ hasText: orderNumStr })
      .first();

  const waitingCard = cardIn(waitingCol);
  await expect(waitingCard).toBeVisible({ timeout: 10000 });

  const patchDone = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && /\/status$/.test(new URL(response.url()).pathname),
  );
  await waitingCard.getByTestId('kds-status-toggle').click();
  expect((await patchDone).ok()).toBeTruthy();

  // Once the card stops being busy, the row must already have left Waiting.
  await expect
    .poll(async () => {
      if ((await waitingCard.count()) === 0) return 'moved';
      const cls = (await waitingCard.getAttribute('class')) ?? '';
      return cls.includes('pointer-events-none') ? 'busy' : 'stale';
    })
    .not.toBe('busy');
  await expect(waitingCard).toHaveCount(0, { timeout: 100 });
  await expect(cardIn(preparingCol)).toBeVisible();

  await expect(page.getByText('Item marked as Preparing')).toBeVisible();
  await expect(page.getByText('Failed to update item')).toHaveCount(0);
  expect(statusPatches).toHaveLength(1);
});
