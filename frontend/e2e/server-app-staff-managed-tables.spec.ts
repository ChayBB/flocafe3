import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const ownerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
};

async function setMode(page: Page, mode: 'manual' | 'staff_managed', backup_enabled = false) {
  const response = await page.request.put(`${E2E_BASE_URL}/api/tables/owner-assignment`, {
    headers: ownerHeaders,
    data: { mode, backup_enabled },
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

  test('staff type table ranges for their main and backup tables', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const base = 9000 + Math.floor(Math.random() * 900) * 10;
    const ids: Record<number, string> = {};
    for (const offset of [0, 1, 2, 4]) {
      const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers: ownerHeaders,
        data: { number: String(base + offset), capacity: 2 },
      });
      expect(created.ok()).toBeTruthy();
      ids[offset] = (await created.json()).table.id;
    }
    await setMode(page, 'staff_managed', true);
    const row = await openProfile(page);
    await row.click();
    const picker = page.getByTestId('staff-table-picker');
    const primary = picker.getByTestId('staff-range-primary');
    const backup = picker.getByTestId('staff-range-backup');
    await primary.getByRole('textbox').nth(0).fill(String(base));
    await primary
      .getByRole('textbox')
      .nth(1)
      .fill(String(base + 1));
    await expect(primary).toContainText('2 tables');
    await backup
      .getByRole('textbox')
      .nth(0)
      .fill(String(base + 1));
    await backup
      .getByRole('textbox')
      .nth(1)
      .fill(String(base + 1));
    await expect(backup).toContainText('is in both main and backup tables');
    await backup
      .getByRole('textbox')
      .nth(0)
      .fill(String(base + 2));
    await backup
      .getByRole('textbox')
      .nth(1)
      .fill(String(base + 4));
    await expect(backup).toContainText('2 tables');
    await expect(picker.getByTestId('staff-range-total')).toHaveText('4 tables');
    await picker.screenshot({ path: test.info().outputPath('staff-table-ranges.png') });
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toHaveCount(0);

    const list = await (
      await page.request.get(`${E2E_BASE_URL}/api/tables`, { headers: ownerHeaders })
    ).json();
    const byId = new Map(
      (list.tables ?? list).map((table: { id: string }) => [table.id, table] as const),
    );
    const staffId = (byId.get(ids[0]) as { owner_user_id: string }).owner_user_id;
    expect(staffId).toBeTruthy();
    expect((byId.get(ids[1]) as { owner_user_id: string }).owner_user_id).toBe(staffId);
    expect((byId.get(ids[2]) as { backup_user_id: string }).backup_user_id).toBe(staffId);
    expect((byId.get(ids[4]) as { backup_user_id: string }).backup_user_id).toBe(staffId);
    expect((byId.get(ids[2]) as { owner_user_id: string | null }).owner_user_id).toBeNull();
  });
});
