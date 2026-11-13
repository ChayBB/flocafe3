import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_SERVER_APP_BASE_URL as SERVER_APP } from './helpers/urls';
import { E2E_PASSWORD, E2E_OPERATIONAL_PASSWORD, getE2eToken } from './helpers/test-auth';

// 1x1 orange PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

test('a small store logo uploads under the app CSP and is saved', async ({ page }) => {
  const owner = { Authorization: `Bearer ${getE2eToken()}` };
  const enabled = await page.request.put(`${BASE}/api/settings/server_app_enabled`, {
    headers: owner,
    data: { value: 'true' },
  });
  expect(enabled.ok()).toBeTruthy();
  await page.request.put(`${BASE}/api/settings/branding`, {
    headers: owner,
    data: { store_logo: '' },
  });

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20000 });

  await page.goto(`${BASE}/settings?tab=store`);
  const card = page.getByTestId('settings-store-branding');
  await expect(card).toBeVisible();
  await page.getByTestId('settings-store-logo-input').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });

  await expect(card.locator('img').first()).toHaveAttribute('src', /^data:image\/webp;base64,/);
  await expect(page.getByTestId('sidebar-store-logo')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/,
  );
  await expect(page.getByTestId('sidebar-store-header')).toContainText(/\S/);
  const saved = await page.request.get(`${BASE}/api/settings/branding`, { headers: owner });
  const branding = await saved.json();
  expect(branding.store_logo).toMatch(/^data:image\/webp;base64,/);
  expect(branding.receipt_logo).toMatch(/^data:image\//);
  expect(JSON.parse(branding.receipt_logo_raster).variants['576']).toBeTruthy();
  await expect(card.getByAltText(/1-bit/)).toBeVisible();
  const invalid = await page.request.put(`${BASE}/api/settings/branding`, {
    headers: owner,
    data: { store_logo: '', receipt_logo_raster: 'invalid' },
  });
  expect(invalid.status()).toBe(400);
  const unchanged = await page.request.get(`${BASE}/api/settings/branding`, { headers: owner });
  expect((await unchanged.json()).store_logo).toBe(branding.store_logo);
  await card.getByRole('button', { name: 'Remove photo', exact: true }).first().click();
  await expect(card.getByAltText(/1-bit/)).toHaveCount(0);
  const cleared = await page.request.get(`${BASE}/api/settings/branding`, { headers: owner });
  const clearedBranding = await cleared.json();
  expect(clearedBranding.store_logo).toBe('');
  expect(clearedBranding.receipt_logo).toBe('');
  expect(clearedBranding.receipt_logo_raster).toBe('');
  await page.goto(`${BASE}/settings?tab=server-app`);
  await expect(page.getByTestId('settings-store-branding')).toHaveCount(0);
});

test('POS omits store branding while Server App keeps the logo and cover without the name', async ({
  page,
  context,
}) => {
  const owner = { Authorization: `Bearer ${getE2eToken()}` };
  const staff = {
    Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
  };
  const before = await page.request.get(`${BASE}/api/settings/branding`, { headers: owner });
  const original = await before.json();
  const image = `data:image/png;base64,${PNG.toString('base64')}`;
  const cashierEmail = `branding-cashier-${Date.now()}@flo.local`;
  const cashierResponse = await page.request.post(`${BASE}/api/staff`, {
    headers: owner,
    data: {
      name: 'Branding cashier',
      email: cashierEmail,
      role: 'cashier',
      password: E2E_OPERATIONAL_PASSWORD,
    },
  });
  expect(cashierResponse.status()).toBe(201);
  const cashier = (await cashierResponse.json()).staff;
  const permissions = await page.request.get(`${BASE}/api/authorization/users/${cashier.id}`, {
    headers: owner,
  });
  const { revision } = await permissions.json();
  expect(
    (
      await page.request.put(`${BASE}/api/authorization/users/${cashier.id}`, {
        headers: owner,
        data: { revision, overrides: [{ permission_id: 'settings.view', effect: 'deny' }] },
      })
    ).ok(),
  ).toBeTruthy();
  const cashierHeaders = {
    Authorization: `Bearer ${getE2eToken(cashier.id, cashierEmail, 'cashier')}`,
  };

  try {
    const saved = await page.request.put(`${BASE}/api/settings/branding`, {
      headers: owner,
      data: { store_logo: image, store_cover: image },
    });
    expect(saved.ok()).toBeTruthy();
    expect(
      (
        await page.request.get(`${BASE}/api/settings/branding`, { headers: cashierHeaders })
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.put(`${BASE}/api/settings/branding`, {
          headers: staff,
          data: { store_logo: '' },
        })
      ).status(),
    ).toBe(403);
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill(cashierEmail);
    await page.locator('#password').fill(E2E_OPERATIONAL_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/pos\/?$/);
    await expect(page.getByTestId('pos-store-banner')).toHaveCount(0);
    const server = await context.newPage();
    await server.goto(`${SERVER_APP}/server-standalone`);
    await server.evaluate(
      (token) => localStorage.setItem('flocafe:server-app-token', token),
      getE2eToken('e2e-server', 'server@flo.local', 'server'),
    );
    await server.reload();
    await expect(server.getByTestId('server-app-header-name')).toHaveCount(0);
    await expect(server.getByTestId('server-app-header-logo')).toBeVisible();
    await expect(server.getByTestId('server-app-header-cover')).toBeVisible();
    expect(
      await server
        .getByTestId('server-app-header-cover')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    ).toBe(true);
    await page.request.put(`${BASE}/api/settings/branding`, {
      headers: owner,
      data: { store_cover: '' },
    });
    await server.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(server.getByTestId('server-app-header-cover')).toHaveCount(0);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('pos-store-cover')).toHaveCount(0);
  } finally {
    await page.request
      .put(`${BASE}/api/settings/branding`, { headers: owner, data: original })
      .catch(() => {});
    await page.request
      .delete(`${BASE}/api/staff/${cashier.id}`, { headers: owner })
      .catch(() => {});
  }
});
