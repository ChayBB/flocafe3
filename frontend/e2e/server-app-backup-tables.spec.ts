import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';
const headers = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};

async function createTables(page: Page, numbers: number[]) {
  const ids: Record<number, string> = {};
  for (const number of numbers) {
    const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: String(number), capacity: 2 },
    });
    expect(created.ok()).toBeTruthy();
    ids[number] = (await created.json()).table.id;
  }
  return ids;
}

async function assign(page: Page, kind: 'owner' | 'backup', tableIds: string[]) {
  const assigned = await page.request.put(`${E2E_BASE_URL}/api/tables/staff-tables`, {
    headers,
    data: { user_id: 'e2e-server', table_ids: tableIds, kind },
  });
  expect(assigned.ok()).toBeTruthy();
}

async function openAsServer(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
  );
  await page.reload();
  return page.getByTestId('server-app-table-picker');
}

const card = (picker: ReturnType<Page['getByTestId']>, number: number) =>
  picker.getByRole('button', { name: new RegExp(`^${number}(?!\d)`) });

test('Select Table files main tables first, then a folder per backup run', async ({ page }) => {
  const base = 9000 + Math.floor(Math.random() * 90) * 10;
  const numbers = [1, 2, 3, 4, 5, 6, 7].map((offset) => base + offset);
  const ids = await createTables(page, numbers);
  try {
    await assign(page, 'owner', [ids[base + 5], ids[base + 6]]);
    await assign(page, 'backup', [ids[base + 1], ids[base + 4], ids[base + 7]]);

    const picker = await openAsServer(page);
    const tabs = picker.getByTestId('server-app-table-tabs');
    const mainTab = tabs.getByRole('tab', { name: 'Main tables' });
    const beforeTab = tabs.getByRole('tab', { name: `${base + 1}–${base + 4}`, exact: true });
    const afterTab = tabs.getByRole('tab', { name: String(base + 7), exact: true });
    await expect(mainTab).toHaveAttribute('aria-selected', 'true');
    await expect(mainTab).toHaveAttribute('data-table-tab', 'main');
    await expect(card(picker, base + 5)).toBeVisible();
    await expect(card(picker, base + 6)).toBeVisible();
    await expect(card(picker, base + 1)).toHaveCount(0);
    await expect(beforeTab).toHaveAttribute('data-table-tab', 'backup');
    await expect(afterTab).toHaveAttribute('data-table-tab', 'backup');

    // A backup folder lists every table in its run, including the ones between the backups.
    await beforeTab.click();
    await expect(beforeTab).toHaveAttribute('aria-selected', 'true');
    for (const offset of [1, 2, 3, 4]) {
      await expect(card(picker, base + offset)).toHaveAttribute('data-backup-table', 'true');
    }
    await expect(card(picker, base + 5)).toHaveCount(0);
    await picker.screenshot({ path: test.info().outputPath('table-tabs.png') });

    await afterTab.click();
    await expect(card(picker, base + 7)).toBeVisible();
    await expect(card(picker, base + 4)).toHaveCount(0);

    // A backup table can be picked like a main table.
    await card(picker, base + 7).click();
    await expect(
      page.getByTestId('server-app-table-button').getByTestId('server-app-table-button-name'),
    ).toHaveText(String(base + 7));
  } finally {
    for (const id of Object.values(ids)) {
      await page.request.delete(`${E2E_BASE_URL}/api/tables/${id}`, { headers });
    }
  }
});

test('with backup tables turned off, Select Table shows only the main tables', async ({ page }) => {
  const base = 9000 + Math.floor(Math.random() * 90) * 10;
  const ids = await createTables(page, [base + 1, base + 2]);
  try {
    await assign(page, 'owner', [ids[base + 2]]);
    await assign(page, 'backup', [ids[base + 1]]);
    const off = await page.request.put(`${E2E_BASE_URL}/api/tables/owner-assignment`, {
      headers,
      data: { backup_enabled: false },
    });
    expect(off.ok()).toBeTruthy();

    const picker = await openAsServer(page);
    await expect(page.getByTestId('server-app-table-picker-heading')).toHaveText('Tables');
    await expect(picker.getByTestId('server-app-table-tabs')).toHaveCount(0);
    await expect(card(picker, base + 2)).toBeVisible();
    await expect(card(picker, base + 1)).toHaveCount(0);
  } finally {
    await page.request.put(`${E2E_BASE_URL}/api/tables/owner-assignment`, {
      headers,
      data: { backup_enabled: true },
    });
    for (const id of Object.values(ids)) {
      await page.request.delete(`${E2E_BASE_URL}/api/tables/${id}`, { headers });
    }
  }
});
