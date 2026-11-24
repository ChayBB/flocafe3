import { leaveStaffLanding, logoutServerApp, openServerAppTables } from './helpers/server-app';
import { test, expect, Page } from '@playwright/test';
import { E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';
import { E2E_BASE_URL } from './helpers/urls';

const TOKEN_KEY = 'flocafe:server-app-token';
const SERVER_EMAIL = 'server@flo.local';

async function openLogin(page: Page): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...parsed.state, language: 'en' };
    localStorage.setItem('pos-settings', JSON.stringify(parsed));
  });
  await page.reload();
}

async function submitLogin(page: Page, _identifier: string, secret: string): Promise<void> {
  const code = secret === E2E_PASSWORD ? '4242' : secret.replace(/\D/g, '').slice(0, 4);
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/api/auth/login') && res.request().method() === 'POST',
  );
  await page.getByPlaceholder('Staff code').fill(code);
  await response;
}

async function signIn(page: Page, identifier = SERVER_EMAIL, secret = E2E_PASSWORD): Promise<void> {
  await submitLogin(page, identifier, secret);
  // Staff choose a table first; the table QR button appears only after that.
  await openServerAppTables(page);
  await page.getByTestId('server-app-table-picker').getByRole('button').first().click();
  await expect(page.getByTestId('server-app-table-qr-button')).toBeVisible();
}

async function createStaff(
  page: Page,
  body: { name: string; password: string; role: string; pin?: string; staff_code?: string },
): Promise<void> {
  const res = await page.request.post(`${E2E_BASE_URL}/api/staff`, {
    headers: { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` },
    data: body,
  });
  expect(res.ok()).toBeTruthy();
}

test.describe('Server App session', () => {
  test('one staff-code field signs in automatically once four digits are entered', async ({
    page,
  }) => {
    const name = `Auto ${Date.now()}`;
    await createStaff(page, { name, password: '7314', role: 'server', staff_code: '7314' });
    await openLogin(page);
    await expect(page.locator('form input')).toHaveCount(1);
    let attempts = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/auth/login') && request.method() === 'POST') attempts++;
    });
    await page.getByPlaceholder('Staff code').fill('731');
    expect(attempts).toBe(0);
    await page.getByPlaceholder('Staff code').fill('7314');
    await leaveStaffLanding(page);
    await expect(page.getByTestId('server-app-staff-name')).toHaveText(name);
    await expect(page.getByTestId('server-app-table-qr-button')).toBeVisible();
    expect(attempts).toBe(1);
    await expect(page.locator('form input')).toHaveCount(0);
  });

  test('code-only login rejects unknown, ambiguous and unauthorized codes', async ({ page }) => {
    const headers = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    for (const name of [`Duplicate A ${Date.now()}`, `Duplicate B ${Date.now()}`]) {
      await createStaff(page, { name, password: '8625', role: 'server', staff_code: '8625' });
    }
    await createStaff(page, {
      name: `Cashier ${Date.now()}`,
      password: '9846',
      role: 'cashier',
      staff_code: '9846',
    });
    const post = (staff_code: string) =>
      page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/auth/login`, { data: { staff_code } });
    expect((await post('0000')).status()).toBe(401);
    const duplicate = await post('8625');
    expect(duplicate.status()).toBe(401);
    expect((await duplicate.json()).code).toBe('ambiguous_credentials');
    expect((await post('9846')).status()).toBe(403);
    const created = await page.request.post(`${E2E_BASE_URL}/api/staff`, {
      headers,
      data: {
        name: `Inactive ${Date.now()}`,
        password: '7356',
        role: 'server',
        staff_code: '7356',
      },
    });
    const body = await created.json();
    const id = body.user?.id ?? body.staff?.id;
    expect(id).toBeTruthy();
    expect(
      (
        await page.request.post(`${E2E_BASE_URL}/api/staff/${id}/deactivate`, {
          headers,
        })
      ).ok(),
    ).toBeTruthy();
    expect((await post('7356')).status()).toBe(401);
  });

  test('sign-in screen shows a red user icon and the signed-in header a green one', async ({
    page,
  }) => {
    await openLogin(page);
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
    await expect(page.getByTestId('server-app-table-qr-button')).toHaveCount(0);

    await signIn(page);
    await expect(page.getByTestId('server-app-table-qr-button')).toHaveClass(/bg-white/);
  });

  test('the session token ends at a 06:00 boundary within the next 24 hours', async ({ page }) => {
    await openLogin(page);
    await signIn(page);
    const exp = await page.evaluate(
      (key) => JSON.parse(atob(localStorage.getItem(key)!.split('.')[1])).exp as number,
      TOKEN_KEY,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThan(nowSeconds);
    expect(exp - nowSeconds).toBeLessThanOrEqual(24 * 3600);
    expect(exp % 900).toBe(0);
  });

  test('the page signs out by itself when the session ends', async ({ page }) => {
    await page.clock.install();
    await openLogin(page);
    await signIn(page);
    await page.clock.fastForward('25:00:00');
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  });

  test('the staff sign-in screen still offers sign-out', async ({ page }) => {
    await openLogin(page);
    await signIn(page);
    await logoutServerApp(page);
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
  });

  test('signs in with the staff name and account password, ignoring letter case', async ({
    page,
  }) => {
    await openLogin(page);
    await signIn(page, 'e2e SERVER');
  });

  test('a manager signs in with the staff name and PIN', async ({ page }) => {
    const name = `Pin ${Math.random().toString(36).slice(2, 7)}`;
    await createStaff(page, { name, password: 'E2ePass123!', role: 'manager', pin: '4821' });
    await openLogin(page);
    await signIn(page, name, '4821');
  });

  test('a server signs in with the staff name and 4-digit staff code', async ({ page }) => {
    const name = `Coded ${Math.random().toString(36).slice(2, 7)}`;
    await createStaff(page, { name, password: '1357', role: 'server', staff_code: '7319' });
    await openLogin(page);
    await submitLogin(page, name, '7318');
    await expect(page.getByTestId('server-app-table-qr-button')).toHaveCount(0);
    await submitLogin(page, name, '7319');
    await leaveStaffLanding(page);
    await expect(page.getByTestId('server-app-staff-name')).toContainText(name);
  });

  test('a wrong code is refused and the screen stays signed out', async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, 'E2E server', '000000x');
    await expect(page.getByTestId('server-app-table-qr-button')).toHaveCount(0);
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
  });

  test('two staff with the same name and code are refused as ambiguous', async ({ page }) => {
    const name = `Dup ${Math.random().toString(36).slice(2, 7)}`;
    await createStaff(page, { name, password: '2468', role: 'server' });
    await createStaff(page, { name, password: '2468', role: 'server' });
    await openLogin(page);
    const response = page.waitForResponse((res) => res.url().endsWith('/api/auth/login'));
    await submitLogin(page, name, '2468');
    const login = await response;
    expect(login.status()).toBe(401);
    expect((await login.json()).code).toBe('ambiguous_credentials');
    await expect(page.getByTestId('server-app-table-qr-button')).toHaveCount(0);
  });
});
