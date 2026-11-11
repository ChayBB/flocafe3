import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  E2E_PASSWORD,
  getE2eToken,
  readOrdersLayout,
  setLanguage,
  setOrdersLayout,
} from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { printBillFirst } from './helpers/bill-print';

/**
 * The shop can switch the built-in tenders off in Settings → Payments; a switched-off
 * tender disappears from checkout and comes back when switched on again.
 */

const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};
const TENDER_KEYS = ['payment_cash_enabled', 'payment_card_enabled', 'payment_wallet_enabled'];

async function setTender(request: APIRequestContext, key: string, enabled: boolean) {
  const response = await request.put(`${BASE}/api/settings/${key}`, {
    headers: managerHeaders,
    data: { value: String(enabled) },
  });
  expect(response.status()).toBe(200);
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
}

/** Orders (card layout) opens checkout for a fresh takeaway order once its tender switches load. */
async function openCheckout(page: Page): Promise<void> {
  const created = await page.request.post(`${BASE}/api/orders`, {
    headers: managerHeaders,
    data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = (await created.json()).order as { id: number; order_number: string };
  await printBillFirst(page.request, managerHeaders, order.id);
  await page.goto(`${BASE}/orders`);
  await page
    .getByPlaceholder(/search/i)
    .first()
    .fill(order.order_number);
  await expect(page.getByText(`#${order.order_number}`)).toBeVisible();
  const settingsRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/settings/payment_card_enabled',
  );
  await page.getByRole('button', { name: /^Confirm payment/i }).click();
  expect((await settingsRead).ok()).toBeTruthy();
}

test.describe('built-in payment method switches', () => {
  test.afterEach(async ({ request }) => {
    for (const key of TENDER_KEYS) await setTender(request, key, true);
  });

  test('settings switch persists and starts on for every built-in tender', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/settings?tab=payments`);
    for (const key of ['cash', 'card', 'wallet']) {
      await expect(page.getByTestId(`builtin-payment-${key}`)).toBeChecked();
    }
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/settings/payment_card_enabled',
    );
    await page.getByTestId('builtin-payment-card').uncheck();
    expect((await saved).status()).toBe(200);

    await page.reload();
    await expect(page.getByTestId('builtin-payment-card')).not.toBeChecked();
    await expect(page.getByTestId('builtin-payment-cash')).toBeChecked();
  });

  test('a switched-off tender is hidden at checkout and returns when switched on', async ({
    page,
    request,
  }) => {
    await login(page);
    const layoutBefore = await readOrdersLayout(page, BASE);
    await setOrdersLayout(page, 'cards', BASE);
    try {
      await setTender(request, 'payment_card_enabled', false);
      await openCheckout(page);
      await expect(page.getByTitle('Cash', { exact: true })).toBeVisible();
      await expect(page.getByTitle('Card', { exact: true })).toHaveCount(0);

      await setTender(request, 'payment_card_enabled', true);
      await openCheckout(page);
      await expect(page.getByTitle('Card', { exact: true })).toBeVisible();
      await expect(page.getByTitle('Cash', { exact: true })).toBeVisible();
    } finally {
      await setOrdersLayout(page, layoutBefore, BASE);
    }
  });
});
