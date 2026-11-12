import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  // Playwright writes to a per-test output dir (test-results/), which is
  // gitignored and writable on every platform/CI runner.
  await page.screenshot({ path: test.info().outputPath(filename), fullPage: true });
}

import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
}

test.describe('Batch 5E Migrated Pages & Components E2E Validation', () => {
  test('Batch 5E Pages render correctly in English and Thai with useTranslations and valid leaf keys', async ({
    page,
  }) => {
    await login(page, 'owner@flo.local');

    // ==========================================
    // 1. ENGLISH (EN) BASELINE
    // ==========================================
    await setLanguage(page, 'en');

    // 1a. Settings (EN)
    await page.goto(`${BASE}/settings`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.getByText('Store Details').first()).toBeVisible();
    await captureScreenshot(page, 'batch-5e-settings-en.png');

    // Settings -> Tax configuration panel
    const taxTab = page.locator('button', { hasText: 'Tax Configuration' }).first();
    if (await taxTab.isVisible()) {
      await taxTab.click();
      await page.waitForTimeout(300);
      await captureScreenshot(page, 'batch-5e-settings-tax-en.png');
    }

    // Settings -> Payment methods
    const paymentsTab = page.locator('button', { hasText: 'Payments' }).first();
    if (await paymentsTab.isVisible()) {
      await paymentsTab.click();
      await page.waitForTimeout(300);
      await captureScreenshot(page, 'batch-5e-settings-payments-en.png');
    }

    // 1b. Products (EN)
    await page.goto(`${BASE}/products`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Products');
    await captureScreenshot(page, 'batch-5e-products-en.png');

    // 1c. Addon Groups (EN)
    await page.goto(`${BASE}/addon-groups`);
    await page.waitForURL(
      (url) => url.pathname.startsWith('/products') && url.searchParams.get('tab') === 'addons',
    );
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Products');
    await expect(page.getByRole('tab', { name: 'Addon Groups' })).toHaveAttribute(
      'data-state',
      'active',
    );
    await captureScreenshot(page, 'batch-5e-addon-groups-en.png');

    // 1d. Staff (EN)
    await page.goto(`${BASE}/staff`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Staff');
    await expect(page.getByText('Add Staff').first()).toBeVisible();
    await captureScreenshot(page, 'batch-5e-staff-en.png');

    // 1e. Support (EN)
    await page.goto(`${BASE}/support`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Help & Support');
    await captureScreenshot(page, 'batch-5e-support-en.png');

    // 1f. WhatsApp (EN)
    await page.goto(`${BASE}/whatsapp`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('WhatsApp');
    await captureScreenshot(page, 'batch-5e-whatsapp-en.png');

    // 1g. Print Test (EN)
    await page.goto(`${BASE}/print-test`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Printing Test Page');
    await captureScreenshot(page, 'batch-5e-print-test-en.png');

    // ==========================================
    // 2. THAI (TH)
    // ==========================================
    try {
      await setLanguage(page, 'th');

      await page.goto(`${BASE}/settings`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('การตั้งค่า');
      await expect(page.getByText('ข้อมูลร้าน').first()).toBeVisible();
      await captureScreenshot(page, 'batch-5e-settings-th.png');

      await page.goto(`${BASE}/products`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('สินค้า');
      await captureScreenshot(page, 'batch-5e-products-th.png');

      await page.goto(`${BASE}/addon-groups`);
      await page.waitForURL(
        (url) => url.pathname.startsWith('/products') && url.searchParams.get('tab') === 'addons',
      );
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('สินค้า');
      await expect(page.getByRole('tab', { name: 'กลุ่มตัวเลือกเพิ่ม' })).toHaveAttribute(
        'data-state',
        'active',
      );
      await captureScreenshot(page, 'batch-5e-addon-groups-th.png');

      await page.goto(`${BASE}/staff`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('พนักงาน');
      await captureScreenshot(page, 'batch-5e-staff-th.png');

      await page.goto(`${BASE}/support`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('ช่วยเหลือและฝ่ายสนับสนุน');
      await captureScreenshot(page, 'batch-5e-support-th.png');

      await page.goto(`${BASE}/whatsapp`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('WhatsApp');
      await captureScreenshot(page, 'batch-5e-whatsapp-th.png');

      await page.goto(`${BASE}/print-test`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('หน้าทดสอบการพิมพ์');
      await captureScreenshot(page, 'batch-5e-print-test-th.png');
    } finally {
      await setLanguage(page, 'en');
    }
  });
});
