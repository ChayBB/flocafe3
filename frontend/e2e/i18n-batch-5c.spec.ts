import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M0D6PY3HABMDFH71W637DKE8');

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: true });
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

test('Batch 5C Pages (Dashboard, Orders, Tables, Customers, OrderHistoryGrid) render correctly in English and Thai', async ({
  page,
}) => {
  await login(page, 'owner@flo.local');

  // ==========================================
  // 1. ENGLISH (EN) BASELINE
  // ==========================================
  await setLanguage(page, 'en');

  // 1a. Dashboard (EN)
  await page.goto(`${BASE}/dashboard`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await expect(page.getByText("Today's Sales")).toBeVisible();
  await expect(page.getByText('Running Orders')).toBeVisible();
  await captureScreenshot(page, 'dashboard-en.png');

  // 1b. Orders (EN)
  await page.goto(`${BASE}/orders`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Orders');
  await expect(
    page.getByPlaceholder('Search by order number, name, phone, table, staff, or amount…'),
  ).toBeVisible();
  await captureScreenshot(page, 'orders-en.png');

  // 1c. Tables (EN)
  await page.goto(`${BASE}/tables`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tables');
  // The default view is the list; switch to the floor plan second view.
  await page.getByRole('button', { name: 'Floor plan' }).click();
  await expect(page.getByRole('button', { name: 'Edit layout' })).toBeVisible();
  await captureScreenshot(page, 'tables-en.png');

  // 1d. Customers (EN)
  await page.goto(`${BASE}/customers`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Customers');
  await expect(page.getByText('Add Customer')).toBeVisible();
  await captureScreenshot(page, 'customers-en.png');

  // 1e. Order History Demo (OrderHistoryGrid) (EN)
  await page.goto(`${BASE}/order-history-demo`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Order History');
  await expect(page.getByText('Dine In').first()).toBeVisible();
  await expect(page.getByText('Subtotal').first()).toBeVisible();
  await expect(page.getByText('Print Receipt').first()).toBeVisible();
  await captureScreenshot(page, 'order-history-grid-en.png');

  // ==========================================
  // 2. THAI (TH)
  // ==========================================
  try {
    await setLanguage(page, 'th');

    // 2a. Dashboard (TH)
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('แดชบอร์ด');
    await expect(page.getByText('ยอดขายวันนี้')).toBeVisible();
    await expect(page.getByText('คำสั่งซื้อที่กำลังดำเนินการ')).toBeVisible();
    await captureScreenshot(page, 'dashboard-th.png');

    // 2b. Orders (TH)
    await page.goto(`${BASE}/orders`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('คำสั่งซื้อ');
    await expect(
      page.getByPlaceholder('ค้นหาจากเลขคำสั่งซื้อ ชื่อ โทรศัพท์ โต๊ะ พนักงาน หรือยอดเงิน…'),
    ).toBeVisible();
    await captureScreenshot(page, 'orders-th.png');

    // 2c. Tables (TH)
    await page.goto(`${BASE}/tables`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('โต๊ะ');
    await page.getByRole('button', { name: 'ผังชั้น/โซน' }).click();
    await expect(page.getByRole('button', { name: 'แก้ไขผัง' })).toBeVisible();
    await captureScreenshot(page, 'tables-th.png');

    // 2d. Customers (TH)
    await page.goto(`${BASE}/customers`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ลูกค้า');
    await expect(page.getByText('เพิ่มลูกค้า').first()).toBeVisible();
    await captureScreenshot(page, 'customers-th.png');

    // 2e. Order History Demo (OrderHistoryGrid) (TH)
    await page.goto(`${BASE}/order-history-demo`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ประวัติคำสั่งซื้อ');
    await expect(page.getByText('ทานที่ร้าน').first()).toBeVisible();
    await expect(page.getByText('ยอดรวมย่อย').first()).toBeVisible();
    await expect(page.getByText('พิมพ์ใบเสร็จ').first()).toBeVisible();
    await captureScreenshot(page, 'order-history-grid-th.png');
  } finally {
    await setLanguage(page, 'en');
  }
});
