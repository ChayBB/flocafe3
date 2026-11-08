import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('owner gives a server a 4-digit staff code from the staff page', async ({ page }) => {
  // Failed printer jobs left by other tests can overlay the staff controls.
  await page.route('**/api/printers/unprinted-kots', (route) =>
    route.fulfill({ json: { unprinted: [] } }),
  );

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders|dashboard|settings)/, { timeout: 20000 });
  await page.goto(`${BASE}/staff`);

  const name = `Code ${Math.random().toString(36).slice(2, 7)}`;
  await page.getByRole('button', { name: 'Add Staff' }).click();
  await page.getByPlaceholder('Name', { exact: true }).fill(name);
  const passwordInput = page.getByPlaceholder('Password (4 digits)');
  await passwordInput.pressSequentially('13x579');
  await expect(passwordInput).toHaveValue('1357');
  await page.getByPlaceholder('Confirm password').pressSequentially('1357');

  const codeInput = page.getByTestId('staff-code-input');
  await codeInput.pressSequentially('48a2159');
  await expect(codeInput).toHaveValue('4821');
  await page.getByRole('button', { name: 'Add Staff' }).last().click();

  await expect(page.getByText('Staff added')).toBeVisible();
  const card = page.locator('div.rounded-xl', { hasText: name }).first();
  await expect(card.getByText('Staff code set')).toBeVisible();
});
