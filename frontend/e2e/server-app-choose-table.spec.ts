import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

const SCREENS = [
  { name: 'a phone', width: 390, height: 844, phone: true },
  { name: 'a tablet', width: 820, height: 1180, phone: false },
];

for (const screenSize of SCREENS) {
  test(`on ${screenSize.name}, "Choose a table to send" under the ticket opens the table list in view`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: screenSize.width, height: screenSize.height });
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const headers = { Authorization: `Bearer ${managerToken}` };
    const run = Math.random().toString(36).slice(2, 7);
    const tableName = `Pick ${run}`;
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: tableName, capacity: 4 },
    });
    expect(table.status()).toBe(201);

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
    await page.evaluate(
      ([key, token]) => {
        localStorage.setItem(key, token);
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = { ...parsed.state, language: 'en' };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      },
      [TOKEN_KEY, managerToken],
    );
    await page.reload();

    // Food goes into the ticket before any table is chosen.
    const grid = page.getByTestId('pos-product-grid');
    await grid.getByTestId('pos-product-card').filter({ hasText: 'E2E Coffee' }).click();
    // Staff usually scroll down the menu before opening the ticket.
    await page.mouse.wheel(0, 1500);
    if (screenSize.phone) {
      // With no table yet, the cart button goes straight to the table list.
      await page.getByTestId('server-app-cart-button').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      const chooseTable = page.getByTestId('server-app-choose-table').last();
      await chooseTable.scrollIntoViewIfNeeded();
      await expect(chooseTable).toHaveText('Choose a table to send');
      await chooseTable.click();
    }

    const picker = page.getByTestId('server-app-table-picker');
    await expect(picker).toBeInViewport();
    await picker.getByRole('button', { name: new RegExp(tableName) }).click();
    await expect(page.locator('header')).toContainText(tableName);

    // The ticket keeps its food and is back on screen, ready to send to the chosen table; a phone
    // reopens its cart without another tap.
    await expect(page.getByTestId('server-app-choose-table')).toHaveCount(0);
    const send = page.getByRole('button', { name: 'Send to kitchen' }).last();
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
  });
}
