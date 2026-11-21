import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { loginWithPassword, setLanguage } from './helpers/test-auth';

// The app's service worker would answer the /kds navigation before page.route sees it.
test.use({ serviceWorkers: 'block' });

test('the kitchen ticket print layout lives in the KDS settings and saves straight to the server', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The test server has no /kds route of its own; serve the exported KDS page.
  await page.route(/\/kds(?:\/|$|\?)/, async (route) => {
    if (route.request().isNavigationRequest()) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        path: path.resolve(__dirname, '../out/kds/index.html'),
      });
    } else {
      await route.continue();
    }
  });
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const headers = { Authorization: `Bearer ${token}` };
  const setting = async (key: string) =>
    (await (await page.request.get(`${BASE}/api/settings/${key}`, { headers })).json()).setting
      ?.value;
  const originalKds = await setting('kds_enabled');
  const originalLayout = await setting('kot_print_layout');
  await page.request.put(`${BASE}/api/settings/kds_enabled`, {
    headers,
    data: { value: 'true' },
  });
  const layout = () => setting('kot_print_layout');
  try {
    await page.goto(`${BASE}/settings?tab=receipts-printers`);
    await expect(page.locator('select').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Print layout', exact: true })).toHaveCount(0);

    await page.goto(`${BASE}/kds`);
    await expect(page.getByTestId('kds-workspace')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('kds-settings-button').click();
    const dialog = page.getByTestId('kds-settings-dialog');
    const tabs = dialog.getByRole('tab');
    await expect(tabs).toHaveText(['Display', 'Sound', 'Print layout']);
    await dialog.getByTestId('kds-settings-tab-print').click();

    const separate = dialog.getByRole('checkbox', { name: /Print each menu item separately/ });
    const combined = dialog.getByRole('checkbox', {
      name: /Print all of the table's items together/,
    });
    await separate.check();
    await expect(separate).toBeChecked();
    await expect(combined).not.toBeChecked();
    await expect.poll(layout).toBe('separate');
    await combined.check();
    await expect(separate).not.toBeChecked();
    await expect.poll(layout).toBe('combined');
    // Unticking the chosen layout keeps it, since one layout always applies.
    await combined.click();
    await expect(combined).toBeChecked();
  } finally {
    await page.request.put(`${BASE}/api/settings/kot_print_layout`, {
      headers,
      data: { value: originalLayout ?? 'combined' },
    });
    await page.request.put(`${BASE}/api/settings/kds_enabled`, {
      headers,
      data: { value: originalKds ?? 'false' },
    });
  }
});
