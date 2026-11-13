import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';

const BASE_API = E2E_BASE_URL;
const BASE_KDS = E2E_KDS_BASE_URL;
const BASE_SERVER_APP = E2E_SERVER_APP_BASE_URL;
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M0D9465DMYWJPCZS0XR240HB');

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: true });
}

import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

async function setLanguage(page: Page, token: string, value: string): Promise<void> {
  const res = await page.request.put(`${BASE_API}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  expect(
    res.ok(),
    `setting language=${value} should succeed (status ${res.status()})`,
  ).toBeTruthy();
  await page.evaluate((lang) => {
    try {
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: lang };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    } catch {}
  }, value);
}

test('Batch 5D: KDS and Server App render and function correctly in English and Thai', async ({
  page,
}) => {
  // 1. Setup session & seed data
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');

  // Create table if not present
  await page.request.post(`${BASE_API}/api/tables`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { number: 'Table 1', capacity: 4 },
  });

  // Create a dine-in order with items
  const orderRes = await page.request.post(`${BASE_API}/api/orders`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      type: 'dine_in',
      items: [{ product_id: 'e2e-product', quantity: 2, notes: 'Extra hot' }],
    },
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();

  try {
    // =========================================================================
    // 1. ENGLISH (EN) VERIFICATION
    // =========================================================================
    await setLanguage(page, token, 'en');

    // 1a. Standalone KDS Login Form (EN)
    await page.goto(`${BASE_KDS}/kds-standalone`);
    await page.evaluate(() => {
      localStorage.removeItem('token');
    });
    await page.goto(`${BASE_KDS}/kds-standalone`);
    await expect(page.getByTestId('kds-login-form')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kitchen Display');
    await expect(page.getByText('Sign in with your kitchen staff account')).toBeVisible();
    await expect(page.getByText('Email', { exact: true })).toBeVisible();
    await expect(page.getByText('Password', { exact: true })).toBeVisible();
    await expect(page.getByText('Keep me logged in')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(
      page.getByText('Only chef, manager, or owner roles can access the kitchen display.'),
    ).toBeVisible();
    await captureScreenshot(page, 'kds-login-en.png');

    // Log in to KDS
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
    await expect(page.getByTestId('kds-workspace')).toBeVisible();

    // 1b. Standalone KDS Tabs View (EN)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kitchen Display');
    await expect(page.getByTestId('kds-column-pending')).toBeVisible();
    await expect(page.getByTestId('kds-settings-button')).toBeEnabled();
    await expect(page.getByText('Dine In').first()).toBeVisible();
    await captureScreenshot(page, 'kds-tabs-en.png');

    // 1c. KDS item status toggle (EN): the toggle is the only control; tapping the item opens nothing.
    const ticketEn = page
      .locator('div.bg-card')
      .filter({ hasText: `#${order.order_number}` })
      .first();
    await ticketEn.getByText('E2E Coffee').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(ticketEn.getByRole('button', { name: 'Move to Preparing' }).first()).toBeVisible();
    await captureScreenshot(page, 'kds-item-toggle-en.png');

    // 1d. Standalone KDS Kanban View (EN)
    await expect(page.getByText('Waiting', { exact: true })).toBeVisible();
    await expect(page.getByText('Preparing', { exact: true })).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    await expect(page.getByText('Delivered', { exact: true })).toBeVisible();
    await captureScreenshot(page, 'kds-kanban-en.png');

    // 1e. Server App Login Form (EN)
    await page.goto(`${BASE_SERVER_APP}/server-standalone`);
    await page.evaluate(() => {
      localStorage.removeItem('flocafe:server-app-token');
    });
    await page.goto(`${BASE_SERVER_APP}/server-standalone`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Server App');
    await expect(page.getByText('Tableside ordering for service staff')).toBeVisible();
    await expect(page.getByPlaceholder('Staff name')).toBeVisible();
    await expect(page.getByPlaceholder('Staff code')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await captureScreenshot(page, 'server-login-en.png');

    // Authenticate Server App
    await page.evaluate((tok) => {
      localStorage.setItem('flocafe:server-app-token', tok);
    }, serverToken);
    await page.reload();

    // 1f. Server App Main UI (EN)
    await expect(page.getByTestId('server-app-header')).toBeVisible();
    await expect(page.getByTestId('server-app-header-name')).toHaveCount(0);
    await openServerAppTables(page);
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Current ticket' })).toBeVisible();
    await expect(page.getByText('New items', { exact: true })).toBeVisible();
    await expect(page.getByText('Draft total', { exact: true })).toBeVisible();
    await expect(page.getByText('All', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Search menu')).toBeVisible();
    // The ticket no longer asks for the customer's phone or name.
    await expect(page.getByPlaceholder('Customer name')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    // Click a table and an item — the simple product lands on the ticket on tap; its
    // Edit action is what reopens the addon/instructions modal.
    await page
      .getByRole('button', { name: /Table 1/i })
      .first()
      .click();
    await page.getByText('E2E Coffee').first().click();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(page.getByPlaceholder('e.g., no onions, extra spicy...')).toBeVisible();
    await page.getByRole('button', { name: /Save changes/ }).click();
    await expect(page.getByRole('button', { name: 'Send to kitchen' })).toBeVisible();
    await captureScreenshot(page, 'server-standalone-en.png');

    // =========================================================================
    // 2. THAI (TH) VERIFICATION
    // =========================================================================
    await setLanguage(page, token, 'th');

    // 2a. Standalone KDS Login Form (TH)
    await page.goto(`${BASE_KDS}/kds-standalone`);
    await page.evaluate(() => {
      localStorage.removeItem('token');
    });
    await page.goto(`${BASE_KDS}/kds-standalone`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('kds-login-form')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('จอแสดงผลในครัว');
    await expect(page.getByText('เข้าสู่ระบบด้วยบัญชีพนักงานครัวของคุณ')).toBeVisible();
    await captureScreenshot(page, 'kds-login-th.png');

    // 2b. Server App Login Form (TH)
    await page.goto(`${BASE_SERVER_APP}/server-standalone`);
    await page.evaluate(() => {
      localStorage.removeItem('flocafe:server-app-token');
    });
    await page.goto(`${BASE_SERVER_APP}/server-standalone`);
    await expect(page.getByText('การสั่งซื้อที่โต๊ะสำหรับพนักงานบริการ')).toBeVisible();
    await expect(page.getByPlaceholder('ชื่อพนักงาน')).toBeVisible();
    await captureScreenshot(page, 'server-login-th.png');

    // 2c. Server App Main UI (TH)
    await page.evaluate((tok) => {
      localStorage.setItem('flocafe:server-app-token', tok);
    }, serverToken);
    await page.reload();
    await openServerAppTables(page);
    await expect(page.getByPlaceholder('ค้นหาเมนู')).toBeVisible();
    await captureScreenshot(page, 'server-standalone-th.png');
  } finally {
    let cleanupError: unknown = null;
    try {
      if (order?.id) {
        const cancelRes = await page.request.patch(`${BASE_API}/api/orders/${order.id}/status`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: { status: 'cancelled' },
        });
        if (!cancelRes.ok()) {
          const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
          const ownerUpdateRes = await page.request.put(`${BASE_API}/api/staff/e2e-owner`, {
            headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
            data: { pin: '1111' },
          });
          expect(
            ownerUpdateRes.ok(),
            `owner update should succeed (status ${ownerUpdateRes.status()})`,
          ).toBeTruthy();
          const cancelOwnerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
          const ownerCancelRes = await page.request.patch(
            `${BASE_API}/api/orders/${order.id}/status`,
            {
              headers: {
                Authorization: `Bearer ${cancelOwnerToken}`,
                'Content-Type': 'application/json',
              },
              data: { status: 'cancelled', override_pin: '1111', approver_id: 'e2e-owner' },
            },
          );
          expect(
            ownerCancelRes.ok(),
            `owner cancellation should succeed (status ${ownerCancelRes.status()})`,
          ).toBeTruthy();
        }
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      await setLanguage(page, token, 'en');
    }
    if (cleanupError) {
      throw new Error(`Failed to clean up order ${order?.id}`, { cause: cleanupError });
    }
  }
});
