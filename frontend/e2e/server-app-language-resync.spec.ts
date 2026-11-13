import { test, expect } from '@playwright/test';
import { E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the Server App picks the store language up again when the page comes back into view', async ({
  page,
}) => {
  // The page first sees English (as from a stand-in server), then the store's Thai.
  let language = 'en';
  await page.route('**/api/server-app/info', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, language } });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => localStorage.setItem(key, token),
    [TOKEN_KEY, getE2eToken('e2e-manager', 'manager@flo.local', 'manager')],
  );
  await page.reload();
  const tableButton = page.getByTestId('server-app-table-button');
  await expect(tableButton).toHaveAttribute('aria-label', 'Select a table');

  // Without a reload: returning to the page re-reads the store language.
  language = 'th';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(tableButton).toHaveAttribute('aria-label', 'เลือกโต๊ะ');
});
