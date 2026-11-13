import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

test('a backlog of unprinted tickets leaves page actions and modal controls usable', async ({
  page,
}) => {
  const unprinted = Array.from({ length: 12 }, (_, index) => ({
    id: `${index}:Kitchen`,
    order_id: index,
    order_number: `ORD-${index}`,
    table: String(index),
    station: 'Kitchen',
    created_at: new Date().toISOString(),
  }));
  await page.route('**/api/printers/unprinted-kots', (route) =>
    route.fulfill({ json: { unprinted } }),
  );
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/);
  await page.goto(`${BASE}/products?tab=addons`);
  await expect(page.getByTestId('unprinted-kot')).toHaveCount(12);
  const toggle = page.getByTestId('unprinted-kot-alerts').getByRole('button', { expanded: false });
  await toggle.click();
  await expect(page.getByTestId('unprinted-kot').first()).toBeVisible();
  await page.getByTestId('unprinted-kot-alerts').getByRole('button', { expanded: true }).click();
  await page.getByRole('button', { name: 'Add Addon Group', exact: true }).click({ timeout: 5000 });
  const editor = page.getByTestId('addon-group-editor');
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 5000 });
  await expect(editor).toBeHidden();
  const bounds = await page.getByTestId('unprinted-kot-alerts').boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.4 + 1);
  await expect(page.getByTestId('unprinted-kot')).toHaveCount(12);
});

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
