import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const ownerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
};

async function setMode(page: Page, mode: 'manual' | 'staff_managed') {
  const response = await page.request.put(`${E2E_BASE_URL}/api/tables/owner-assignment`, {
    headers: ownerHeaders,
    data: { mode },
  });
  expect(response.ok()).toBeTruthy();
}

async function openProfile(page: Page) {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...parsed.state, language: 'en' };
    localStorage.setItem('pos-settings', JSON.stringify(parsed));
  });
  await page.reload();
  await page.getByPlaceholder('Staff code').fill('4242');
  const profile = page.getByTestId('server-app-staff-profile');
  await page.getByTestId('server-app-open-profile').or(profile).first().waitFor();
  if (!(await profile.isVisible())) await page.getByTestId('server-app-open-profile').click();
  await expect(profile).toBeVisible();
  return profile.getByTestId('staff-profile-my-tables');
}

test.describe('Staff profile My tables row', () => {
  test.afterEach(async ({ page }) => {
    await setMode(page, 'manual');
  });

  test('shows the table count when the manager assigns tables', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setMode(page, 'manual');
    const row = await openProfile(page);
    await expect(row).toContainText(/\d+ tables?/);
    await expect(row).not.toContainText('Manage tables');
  });

  test('offers Manage tables when staff manage their own tables', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setMode(page, 'staff_managed');
    const row = await openProfile(page);
    await expect(row).toContainText('Manage tables');
    await expect(row).not.toContainText(/\d+ tables?/);
    await row.click();
    await expect(page.getByTestId('staff-table-picker')).toBeVisible();
  });
});
