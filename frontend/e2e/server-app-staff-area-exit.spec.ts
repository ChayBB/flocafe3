import { test, expect } from '@playwright/test';
import { E2E_SERVER_APP_BASE_URL } from './helpers/urls';

const CLOUD_TABLE = 'https://order.flo.test/#table=3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

test.describe('Staff area sign-in opened from the Cloud QR page', () => {
  test('Exit returns the device to the Cloud table it came from', async ({ page }) => {
    await page.route('https://order.flo.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Cloud table</h1>' }),
    );
    const query = new URLSearchParams({ staff: 'area', return: CLOUD_TABLE });
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone/?${query}`);
    await expect(page.getByPlaceholder(/Staff code|รหัสพนักงาน/)).toBeVisible();
    await page.getByTestId('server-app-login-exit').click();
    await expect(page).toHaveURL(CLOUD_TABLE);
  });

  test('a return link that is not a Cloud table page shows no Exit', async ({ page }) => {
    for (const target of ['javascript:alert(1)', 'https://order.flo.test/admin', 'not a url']) {
      const query = new URLSearchParams({ staff: 'area', return: target });
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone/?${query}`);
      await expect(page.getByPlaceholder(/Staff code|รหัสพนักงาน/)).toBeVisible();
      await expect(page.getByTestId('server-app-login-exit')).toHaveCount(0);
    }
  });
});
