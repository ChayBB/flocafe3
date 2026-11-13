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

async function submitLogin(page: Page, identifier: string, secret: string): Promise<void> {
  await page.getByPlaceholder('Staff name').fill(identifier);
  await page.getByPlaceholder('Staff code').fill(secret);
  await page.getByRole('button', { name: 'Sign In' }).click();
}

async function signIn(page: Page, identifier = SERVER_EMAIL, secret = E2E_PASSWORD): Promise<void> {
  await submitLogin(page, identifier, secret);
  await expect(page.getByTestId('server-app-session-button')).toBeVisible();
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
  test('sign-in screen shows a red user icon and the signed-in header a green one', async ({
    page,
  }) => {
    await openLogin(page);
    await expect(page.locator('form svg.text-red-600')).toBeVisible();
    await expect(page.getByTestId('server-app-session-button')).toHaveCount(0);

    await signIn(page);
    await expect(page.getByTestId('server-app-session-button')).toHaveClass(/bg-brand/);
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

  test('pressing the user icon signs out', async ({ page }) => {
    await openLogin(page);
    await signIn(page);
    await page.getByTestId('server-app-session-button').click();
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
    await createStaff(page, { name, password: '1357', role: 'server', staff_code: '4821' });
    await openLogin(page);
    await submitLogin(page, name, '4820');
    await expect(page.getByTestId('server-app-session-button')).toHaveCount(0);
    await signIn(page, name, '4821');
  });

  test('a wrong code is refused and the screen stays signed out', async ({ page }) => {
    await openLogin(page);
    await submitLogin(page, 'E2E server', '000000x');
    await expect(page.getByTestId('server-app-session-button')).toHaveCount(0);
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
    await expect(page.getByTestId('server-app-session-button')).toHaveCount(0);
  });
});
