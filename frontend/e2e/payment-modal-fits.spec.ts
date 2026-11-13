import { printBillFirst } from './helpers/bill-print';
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

for (const viewport of [
  // 15-inch screens: 1366x768 and 1024x768 panels, and 1920x1080 at 150% scaling, each less the
  // taskbar and window title bar.
  { width: 1366, height: 768 },
  { width: 1366, height: 700 },
  { width: 1024, height: 700 },
  { width: 1280, height: 650 },
]) {
  test(`the payment screen shows the whole keypad without scrolling at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const headers = {
      Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
    };
    const run = Math.random().toString(36).slice(2, 7);
    const table = await page.request.post(`${BASE}/api/tables`, {
      headers,
      data: { number: `Pay ${run}`, capacity: 4 },
    });
    const order = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: (await table.json()).table.id,
        items: [
          { product_id: 'e2e-product', quantity: 2 },
          {
            product_id: 'e2e-product',
            quantity: 1,
            special_instructions: 'second',
          },
        ],
      },
    });
    expect(order.status()).toBe(201);
    const created = (await order.json()).order;
    await printBillFirst(page.request, headers, created.id);

    // The tallest case: a third payment method and split checks on (both restored afterwards).
    const methods = (
      await (await page.request.get(`${BASE}/api/payment-methods`, { headers })).json()
    ).payment_methods as {
      id: number;
      name: string;
      is_active: boolean | number;
    }[];
    let addedMethodId: number | null = null;
    if (methods.filter((method) => method.is_active).length < 3) {
      const added = await page.request.post(`${BASE}/api/payment-methods`, {
        headers,
        data: { name: `QR ${run}` },
      });
      expect(added.status()).toBe(201);
      addedMethodId = (await added.json()).payment_method.id;
    }
    const splitBefore =
      (
        await (
          await page.request.get(`${BASE}/api/settings/split_checks_enabled`, {
            headers,
          })
        ).json()
      ).setting?.value ?? 'false';
    await page.request.put(`${BASE}/api/settings/split_checks_enabled`, {
      headers,
      data: { value: 'true' },
    });
    try {
      await page.goto(`${BASE}/auth/login`);
      await page.locator('#email').fill('owner@flo.local');
      await page.locator('#password').fill(E2E_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
      await page.goto(`${BASE}/orders`);
      await page
        .getByRole('button')
        .filter({ hasText: `#${created.order_number}` })
        .first()
        .click();
      await page.getByRole('button', { name: /Checkout|Take Payment|Confirm payment/ }).click();

      await page.getByRole('button', { name: 'Cash', exact: true }).click();
      const keypad = page.getByLabel('Numeric keypad');
      await expect(keypad).toBeVisible();
      await page.screenshot({
        path: `test-results/payment-modal-${viewport.width}x${viewport.height}.png`,
      });

      // The modal body needs no scrolling, and the keypad's last key sits above the pay button.
      const body = keypad.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');
      const { scrollHeight, clientHeight } = await body.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 1);
      const lastKey = (await keypad.getByRole('button', { name: '0', exact: true }).boundingBox())!;
      const payButton = (await page
        .locator('div.fixed')
        .filter({ has: page.getByRole('heading', { name: 'Payment', exact: true }) })
        .getByRole('button', { name: /^(?:Pay|Confirm payment) / })
        .boundingBox())!;
      expect(lastKey.y + lastKey.height).toBeLessThan(payButton.y);
      await expect(keypad.getByRole('button', { name: 'Clear amount' })).toBeVisible();
      await expect(page.getByTestId('split-check-section')).toBeVisible();

      // One tender at a time: choosing Card moves the whole balance off Cash.
      const tender = (name: string) =>
        page.getByRole('button', { name, exact: true }).locator('xpath=..').getByRole('spinbutton');
      expect(Number(await tender('Cash').inputValue())).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Card', exact: true }).click();
      await expect(tender('Cash')).toHaveValue('');
      expect(Number(await tender('Card').inputValue())).toBeGreaterThan(0);
      await tender('Cash').fill('500');
      await expect(tender('Card')).toHaveValue('');
    } finally {
      await page.request.put(`${BASE}/api/settings/split_checks_enabled`, {
        headers,
        data: { value: splitBefore },
      });
      if (addedMethodId !== null) {
        await page.request.put(`${BASE}/api/payment-methods/${addedMethodId}`, {
          headers,
          data: { is_active: false },
        });
      }
    }
  });
}
