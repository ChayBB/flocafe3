import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const owner = () => ({
  Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
});

async function signInAs(page: Page, name: string, password: string): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...parsed.state, language: 'en' };
    localStorage.setItem('pos-settings', JSON.stringify(parsed));
  });
  await page.reload();
  await page.getByPlaceholder('Staff code').fill(password === 'E2ePass123!' ? '4242' : password);
  await openServerAppTables(page);
  // A staff member must choose a table before the table QR button is enabled.
  await expect(page.getByTestId('server-app-table-qr-button')).toBeDisabled();
}

test('Server App lists only the tables a staff member owns, but a table QR still opens any table', async ({
  page,
}) => {
  const run = Math.random().toString(36).slice(2, 7);
  const staffName = `Owner ${run}`;
  const staff = await page.request.post(`${E2E_BASE_URL}/api/staff`, {
    headers: owner(),
    data: { name: staffName, password: '3579', role: 'server' },
  });
  expect(staff.ok()).toBeTruthy();
  const { staff: member } = await staff.json();

  const mine = `Mine ${run}`;
  const theirs = `Theirs ${run}`;
  const ids: Record<string, string> = {};
  for (const number of [mine, theirs]) {
    const res = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: owner(),
      data: { number, capacity: 2, floor: `Zone ${run}` },
    });
    expect(res.ok()).toBeTruthy();
    ids[number] = (await res.json()).table.id;
  }
  const assigned = await page.request.put(`${E2E_BASE_URL}/api/tables/${ids[mine]}/owner`, {
    headers: owner(),
    data: { user_id: member.id },
  });
  expect(assigned.ok()).toBeTruthy();

  await signInAs(page, staffName, '3579');
  await openServerAppTables(page);
  await expect(page.getByRole('button', { name: new RegExp(mine) })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(theirs) })).toHaveCount(0);
  // No table is chosen until the staff member picks one.
  await expect(page.getByTestId('server-app-table-button-name')).toHaveCount(0);
  await expect(page.getByTestId('server-app-table-qr-button')).toBeDisabled();
  await page
    .getByTestId('server-app-table-picker')
    .getByRole('button', { name: new RegExp(mine) })
    .click();
  await expect(page.getByTestId('server-app-table-qr-button')).toBeEnabled();

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${ids[theirs]}`);
  await expect(page.getByTestId('server-app-table-button-name')).toHaveText(theirs);
});
