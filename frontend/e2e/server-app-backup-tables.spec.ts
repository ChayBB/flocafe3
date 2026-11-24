import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

async function holdTablesButton(page: Page): Promise<void> {
  const button = page.getByTestId('server-app-table-button');
  // Select Table scrolls the list into view; wait for the page to settle before pressing.
  await expect
    .poll(async () => {
      const before = await page.evaluate(() => window.scrollY);
      await page.waitForTimeout(150);
      return (await page.evaluate(() => window.scrollY)) === before;
    })
    .toBe(true);
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2300);
  await page.mouse.up();
}

test('holding Select Table switches between own tables and orange backup tables', async ({
  page,
}) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const suffix = Math.random().toString(36).slice(2, 7);
  const create = async (name: string) =>
    (
      await (
        await page.request.post(`${E2E_BASE_URL}/api/tables`, {
          headers,
          data: { number: name, capacity: 2 },
        })
      ).json()
    ).table as { id: string };
  const own = await create(`Own ${suffix}`);
  const backup = await create(`Spare ${suffix}`);
  try {
    for (const [kind, table] of [
      ['owner', own],
      ['backup', backup],
    ] as const) {
      const assigned = await page.request.put(`${E2E_BASE_URL}/api/tables/staff-tables`, {
        headers,
        data: { user_id: 'e2e-server', table_ids: [table.id], kind },
      });
      expect(assigned.ok()).toBeTruthy();
    }

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

    const picker = page.getByTestId('server-app-table-picker');
    const button = page.getByTestId('server-app-table-button');
    const heading = page.getByTestId('server-app-table-picker-heading');
    const ownCard = picker.getByRole('button', { name: new RegExp(`Own ${suffix}`) });
    const backupCard = picker.getByRole('button', { name: new RegExp(`Spare ${suffix}`) });
    await expect(heading).toHaveText('Tables');
    await expect(ownCard).toBeVisible();
    await expect(backupCard).toHaveCount(0);

    // A short tap keeps its usual job; holding switches to the backup tables, on orange cards.
    await holdTablesButton(page);
    await expect(heading).toHaveText('Backup tables');
    await expect(button).toHaveAttribute('data-backup-tables', 'true');
    await expect(button).toContainText('Backup tables');
    await expect(backupCard).toHaveAttribute('data-backup-table', 'true');
    await expect(backupCard).toHaveCSS('background-color', /oklch|rgb\(255, 237, 213\)/);
    await expect(ownCard).toHaveCount(0);

    // A backup table can be picked like an own table.
    await backupCard.click();
    await expect(button.getByTestId('server-app-table-button-name')).toHaveText(`Spare ${suffix}`);

    // Holding again returns to the staff member's own tables.
    await button.click();
    await expect(picker).toBeVisible();
    await holdTablesButton(page);
    await expect(heading).toHaveText('Tables');
    await expect(button).not.toHaveAttribute('data-backup-tables', 'true');
    await expect(ownCard).toBeVisible();
    await expect(backupCard).toHaveCount(0);
  } finally {
    for (const table of [own, backup]) {
      await page.request.delete(`${E2E_BASE_URL}/api/tables/${table.id}`, { headers });
    }
  }
});

test('with backup tables turned off, holding Select Table keeps the own tables', async ({
  page,
}) => {
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const suffix = Math.random().toString(36).slice(2, 7);
  const create = async (name: string) =>
    (
      await (
        await page.request.post(`${E2E_BASE_URL}/api/tables`, {
          headers,
          data: { number: name, capacity: 2 },
        })
      ).json()
    ).table as { id: string };
  const own = await create(`Own ${suffix}`);
  const backup = await create(`Spare ${suffix}`);
  try {
    for (const [kind, table] of [
      ['owner', own],
      ['backup', backup],
    ] as const) {
      const assigned = await page.request.put(`${E2E_BASE_URL}/api/tables/staff-tables`, {
        headers,
        data: { user_id: 'e2e-server', table_ids: [table.id], kind },
      });
      expect(assigned.ok()).toBeTruthy();
    }
    const off = await page.request.put(`${E2E_BASE_URL}/api/tables/owner-assignment`, {
      headers,
      data: { backup_enabled: false },
    });
    expect(off.ok()).toBeTruthy();

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

    const picker = page.getByTestId('server-app-table-picker');
    const heading = page.getByTestId('server-app-table-picker-heading');
    await expect(heading).toHaveText('Tables');
    await expect(picker.getByRole('button', { name: new RegExp(`Own ${suffix}`) })).toBeVisible();

    await holdTablesButton(page);
    await expect(page.getByTestId('server-app-table-button')).not.toHaveAttribute(
      'data-backup-tables',
      'true',
    );
    // Without backups a hold is just a tap, so the list folds away; tap again to bring it back.
    if (!(await picker.isVisible())) await page.getByTestId('server-app-table-button').click();
    await expect(heading).toHaveText('Tables');
    await expect(picker.getByRole('button', { name: new RegExp(`Own ${suffix}`) })).toBeVisible();
    await expect(picker.getByRole('button', { name: new RegExp(`Spare ${suffix}`) })).toHaveCount(
      0,
    );
  } finally {
    await page.request.put(`${E2E_BASE_URL}/api/tables/owner-assignment`, {
      headers,
      data: { backup_enabled: true },
    });
    for (const table of [own, backup]) {
      await page.request.delete(`${E2E_BASE_URL}/api/tables/${table.id}`, { headers });
    }
  }
});
