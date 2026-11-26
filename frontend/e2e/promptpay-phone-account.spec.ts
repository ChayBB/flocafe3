import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

const owner = () => ({
  Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
});

test('a second PromptPay method takes a phone number and can print its QR on bills', async ({
  page,
}) => {
  const listMethods = async () =>
    (
      await (
        await page.request.get(`${BASE}/api/payment-methods?include_inactive=true`, {
          headers: owner(),
        })
      ).json()
    ).payment_methods as { id: number; name: string }[];
  for (const name of ['PromptPay', 'PromptPay phone']) {
    if (!(await listMethods()).some((method) => method.name === name)) {
      const created = await page.request.post(`${BASE}/api/payment-methods`, {
        headers: owner(),
        data: { name },
      });
      expect(created.ok()).toBeTruthy();
    }
  }
  const phoneMethod = (await listMethods()).find((method) => method.name === 'PromptPay phone')!;

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/(pos|orders|dashboard|settings)/, { timeout: 20000 });
  await page.goto(`${BASE}/settings?tab=payments`);

  const form = page.getByTestId(`promptpay-account-form-${phoneMethod.id}`);
  await expect(form).toBeVisible();
  const account = form.getByRole('textbox', {
    name: 'National ID or phone number linked to PromptPay',
  });
  await account.fill('12345');
  await form
    .getByRole('button', { name: 'National ID or phone number linked to PromptPay' })
    .click();
  await expect(
    page.getByText('Enter a 10-digit phone number, 13-digit ID or 15-digit e-wallet ID'),
  ).toBeVisible();

  await account.fill('+66 81-234-5678');
  await form
    .getByRole('button', { name: 'National ID or phone number linked to PromptPay' })
    .click();
  await expect(page.getByText('QR account saved')).toBeVisible();
  await expect(account).toHaveValue('0812345678');

  await form.getByRole('textbox', { name: 'Account owner name' }).fill('Phone holder');
  await form.getByRole('button', { name: 'Account owner name' }).click();
  await expect(page.getByText('Account owner name saved')).toBeVisible();

  const billRadio = form.getByRole('radio', { name: 'Print this QR on bills' });
  await billRadio.click();
  await expect(page.getByText('Bill QR account saved')).toBeVisible();
  await expect(billRadio).toBeChecked();

  const qr = await page.request.get(`${BASE}/api/payment-methods/qr-code`, {
    headers: owner(),
    params: { amount: '120' },
  });
  expect(qr.ok()).toBeTruthy();
  const body = await qr.json();
  expect(body.payload).toContain('0016A000000677010111' + '01130066812345678');
  expect(body.payload).toContain('5406120.00');
  expect(body.account_name).toBe('Phone holder');

  await page.request.put(`${BASE}/api/payment-methods/promptpay-bill-method`, {
    headers: owner(),
    data: { method_id: null },
  });
  await page.request.put(`${BASE}/api/payment-methods/promptpay-accounts/${phoneMethod.id}`, {
    headers: owner(),
    data: { account: '', name: '' },
  });
});
