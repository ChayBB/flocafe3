import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

test('a kitchen ticket that did not print waits on the POS until it is reprinted', async ({
  page,
}) => {
  let unprinted = [
    {
      id: '41:Kitchen',
      order_id: 41,
      order_number: 'ORD-41',
      table: '5',
      station: 'Kitchen',
      created_at: new Date().toISOString(),
    },
  ];
  let reprintBody: unknown;
  let printerReady = false;
  await page.route('**/api/printers/unprinted-kots', (route) =>
    route.fulfill({ json: { unprinted } }),
  );
  await page.route('**/api/printers/print-kot', async (route) => {
    reprintBody = route.request().postDataJSON();
    if (!printerReady) {
      await route.fulfill({
        status: 502,
        json: { detail: 'Timed out connecting to 192.0.2.1:9100' },
      });
      return;
    }
    unprinted = [];
    await route.fulfill({ json: { success: true, warnings: [] } });
  });

  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  await setLanguage(page, 'en');

  const alert = page.getByTestId('unprinted-kot');
  await expect(alert).toContainText('Kitchen ticket not printed');
  await expect(alert).toContainText('Table 5 · Kitchen station');

  await alert.getByRole('button', { name: 'Reprint' }).click();
  await expect(
    page.getByText(
      'Still could not print the kitchen ticket: Timed out connecting to 192.0.2.1:9100',
    ),
  ).toBeVisible();
  await expect(alert).toBeVisible();

  printerReady = true;
  await alert.getByRole('button', { name: 'Reprint' }).click();
  await expect(page.getByText('Kitchen ticket printed')).toBeVisible();
  expect(reprintBody).toEqual({ orderId: 41, retryStation: 'Kitchen' });
  await expect(page.getByTestId('unprinted-kot-alerts')).toHaveCount(0);
});
