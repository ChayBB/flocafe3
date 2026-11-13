import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL as KDS } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('a saved kitchen station shows matching network URLs and QR codes for tablet access', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 800, height: 1024 });
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  const name = `Tablet station ${Date.now()}`;
  const created = await page.request.post(`${BASE}/api/kitchen-stations`, {
    headers,
    data: { name },
  });
  expect(created.status()).toBe(201);
  const stationId = (await created.json()).kitchenStation.id;
  try {
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/);
    await page.goto(`${BASE}/settings?tab=kitchen-stations`);
    await page
      .getByText(name, { exact: true })
      .locator('../..')
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    const access = page.getByTestId('station-kds-access');
    await expect(access.getByRole('link').first()).toBeVisible();
    const links = await access.getByRole('link').all();
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const url = (await link.getAttribute('href'))!;
      expect(new URL(url).port).toBe(new URL(KDS).port);
      expect(new URL(url).hostname).not.toBe('localhost');
      await expect(link.locator('..').getByRole('img')).toHaveAttribute(
        'src',
        await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 256 }),
      );
    }
    const tablet = await context.newPage();
    await tablet.setViewportSize({ width: 800, height: 1024 });
    await tablet.goto((await links[0].getAttribute('href'))!);
    await expect(tablet.getByTestId('kds-login-form')).toBeVisible();
    await page.bringToFront();
    await access.getByRole('button', { name: 'Refresh URLs' }).click();
    await expect(access.getByRole('link').first()).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  } finally {
    await page.request
      .delete(`${BASE}/api/kitchen-stations/${stationId}`, { headers })
      .catch(() => {});
  }
});
