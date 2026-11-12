import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';
import { LANGUAGES } from '../src/lib/i18n/languages';

/** Phase 7 browser coverage for visible print-test labels across every locale. */

const LABELS: Record<string, { basic: string; web: string; whatsapp: string }> = {
  en: { basic: 'Basic Receipt (Thermal)', web: 'Web Print (Browser)', whatsapp: 'WhatsApp Share' },
  th: {
    basic: 'ใบเสร็จพื้นฐาน (เครื่องพิมพ์ความร้อน)',
    web: 'พิมพ์เว็บ (เบราว์เซอร์)',
    whatsapp: 'แชร์ผ่าน WhatsApp',
  },
};

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
}

test('print-test visible labels use the selected UI locale', async ({ page }) => {
  test.setTimeout(90_000);
  await loginAsOwner(page);
  try {
    // Driven from the registry so a newly registered locale cannot be skipped:
    // a missing LABELS entry fails here instead of silently dropping coverage.
    for (const language of Object.keys(LANGUAGES)) {
      const labels = LABELS[language];
      expect(
        labels,
        `print-test label literals are missing for registered locale ${language}`,
      ).toBeTruthy();
      await setLanguage(page, language);
      await page.goto(`${BASE}/print-test`);
      await expect(page.getByRole('button', { name: labels.basic, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: labels.web, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: labels.whatsapp, exact: true })).toBeVisible();
    }
  } finally {
    await setLanguage(page, 'en').catch(() => {});
  }
});
