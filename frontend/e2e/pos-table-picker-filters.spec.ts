import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('the POS table picker filters tables by seat count and by zone', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${token}` };
  const business = await (
    await page.request.get(`${BASE}/api/settings/business`, { headers })
  ).json();
  const run = Date.now().toString(36);
  const zone = `Stage ${run}`;
  const tableIds: string[] = [];

  try {
    await page.request.put(`${BASE}/api/settings/business`, {
      headers,
      data: { ...business, tables_required: true },
    });
    for (const data of [
      { number: `Big-${run}`, capacity: 37 },
      { number: `Zone-${run}`, capacity: 2, section: zone },
    ]) {
      const response = await page.request.post(`${BASE}/api/tables`, { headers, data });
      expect(response.ok()).toBeTruthy();
      tableIds.push((await response.json()).table.id);
    }

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByRole('button', { name: /Select Table/ }).click();
    const picker = page
      .locator('div.fixed.inset-0')
      .filter({ has: page.getByRole('heading', { name: 'Select Table', exact: true }) })
      .last();
    const filters = picker.getByTestId('table-picker-filters');
    const big = picker.getByRole('button', { name: new RegExp(`Big-${run}`) });
    const staged = picker.getByRole('button', { name: new RegExp(`Zone-${run}`) });
    await expect(big).toBeVisible();
    await expect(staged).toBeVisible();

    await expect(filters.getByRole('button', { name: '4+ seats' })).toBeVisible();
    await expect(filters.getByRole('button', { name: '6+ seats' })).toBeVisible();
    await filters.getByRole('button', { name: '8+ seats' }).click();
    await expect(big).toBeVisible();
    await expect(staged).toHaveCount(0);

    await filters.getByRole('button', { name: zone }).click();
    await expect(staged).toBeVisible();
    await expect(big).toHaveCount(0);

    await filters.getByRole('button', { name: 'All', exact: true }).click();
    await expect(big).toBeVisible();
    await expect(staged).toBeVisible();
  } finally {
    for (const id of tableIds) {
      await page.request.post(`${BASE}/api/tables/${id}/deactivate`, { headers });
    }
    await page.request.put(`${BASE}/api/settings/business`, { headers, data: business });
  }
});
