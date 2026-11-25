import { logoutServerApp } from './helpers/server-app';
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createFakeQrRelay } = require('../../tests/helpers/fake-qr-relay.cjs');

const manager = () => ({
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
});

async function setEnglish(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(() => {
    const raw = localStorage.getItem('pos-settings');
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    parsed.state = { ...parsed.state, language: 'en' };
    localStorage.setItem('pos-settings', JSON.stringify(parsed));
  });
}

async function createTable(page: import('@playwright/test').Page) {
  const name = `QR ${Math.random().toString(36).slice(2, 7)}`;
  const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers: manager(),
    data: { number: name, capacity: 2 },
  });
  expect(created.ok()).toBeTruthy();
  const { table } = await created.json();
  const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
    headers: manager(),
  });
  expect(qr.ok()).toBeTruthy();
  const url = new URL((await qr.json()).url as string);
  const token = url.searchParams.get('t') as string;
  return {
    name,
    id: table.id as string,
    token,
    device: await joinDevice(page.request, table.id, token),
    query: `table=${encodeURIComponent(table.id)}&t=${token}`,
  };
}

/** One phone joining the table's session with its slip QR; each phone orders with its own token. */
async function joinDevice(
  request: import('@playwright/test').APIRequestContext,
  tableId: string,
  token: string,
): Promise<string> {
  const joined = await request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/join`, {
    data: { table_id: tableId, table_token: token },
  });
  expect(joined.ok()).toBeTruthy();
  return (await joined.json()).device_token as string;
}

test.describe('Server App guest from a table QR', () => {
  test('loads the menu while joining but waits for the table session before enabling ordering', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    let releaseJoin: () => void;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    let joinStarted = false;
    let menuStarted = false;
    await page.route('**/api/guest/join', async (route) => {
      joinStarted = true;
      await joinGate;
      await route.continue();
    });
    await page.route('**/api/guest/menu', async (route) => {
      menuStarted = true;
      await route.continue();
    });
    try {
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
      await expect.poll(() => joinStarted && menuStarted).toBe(true);
      await expect(page.getByTestId('pos-product-grid')).toHaveCount(0);
    } finally {
      releaseJoin!();
    }
    await expect(
      page.getByTestId('pos-product-grid').getByPlaceholder('Search menu'),
    ).toBeVisible();
  });

  test('reopening after a lost submit response looks up the same request without sending again', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    let original = '';
    let submissions = 0;
    await page.route('**/api/guest/order', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submissions++;
      original = route.request().postData() ?? '';
      await route.abort('connectionreset');
    });
    await page.route('**/api/guest/order/status', async (route) => {
      expect(route.request().postData()).toBe(original);
      await route.fulfill({ status: 201, json: { order_number: 'ORD-RECOVERED' } });
    });
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect.poll(() => submissions).toBe(1);
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'ORD-RECOVERED' })).toBeVisible();
    expect(submissions).toBe(1);
  });

  test('a guest shows the saved cloud QR of the table, and only from a phone seated at that table', async ({
    page,
  }) => {
    const table = await createTable(page);
    const qrPath = `${E2E_SERVER_APP_BASE_URL}/api/guest/table-qr`;
    const stranger = await page.request.get(qrPath, { params: { table_id: table.id, d: 'x' } });
    expect(stranger.status()).toBe(410);
    // Without a cloud connector there is no cloud QR, and the in-store link is never handed out.
    const seated = await page.request.get(qrPath, {
      params: { table_id: table.id, d: table.device },
    });
    expect(seated.status()).toBe(404);
    expect((await seated.json()).code).toBe('cloud_qr_unavailable');

    await setEnglish(page);
    const cloudQr =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    let asked = '';
    await page.route('**/api/guest/table-qr?*', async (route) => {
      asked = route.request().url();
      await route.fulfill({
        json: {
          table: { id: table.id, name: table.name },
          url: 'https://order.example.test/#table=x',
          data_url: cloudQr,
        },
      });
    });
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await page.getByTestId('server-app-table-qr-button').click();
    const dialog = page.getByTestId('guest-table-qr');
    await expect(dialog).toContainText(table.name);
    await expect(dialog.locator('img')).toHaveAttribute('src', cloudQr);
    expect(new URL(asked).searchParams.get('table_id')).toBe(table.id);
  });

  test('shows a Guest label and orange login button, no table picker, and orders for that table only', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);

    const header = page.locator('header');
    await expect(header.getByTestId('server-app-guest-name')).toHaveText('Guest');
    await expect(header.getByTestId('server-app-login-button')).toBeVisible();
    await expect(header.getByTestId('server-app-login-button')).toHaveClass(/bg-brand/);
    await expect(header.getByTestId('server-app-login-button')).toHaveText('Staff');
    await expect(header.getByRole('img', { name: 'Flo' })).toHaveCount(0);
    await expect(header.getByTestId('server-app-table-button')).toHaveCount(0);
    await expect(header.getByTestId('server-app-table-qr-button')).toBeVisible();
    await expect(header).toContainText(table.name);
    await expect(page.getByRole('heading', { name: 'Tables' })).toHaveCount(0);

    // A guest may switch the page's language, and the choice outlives a reload.
    const history = page.getByTestId('server-app-history-button');
    await expect(history).toHaveCSS('background-color', / 0\.85\)$|, 0\.85\)$/);
    await expect(history).toHaveCSS('color', 'rgb(17, 17, 17)');
    await expect(history.locator('svg')).toHaveCSS('color', 'rgb(234, 88, 12)');
    await expect(history).toHaveCSS('border-width', '0px');
    await expect(history).toHaveCSS('opacity', '1');
    await history.hover();
    await expect(history).toHaveCSS('opacity', '1');
    await page.getByTestId('server-app-language-button').click();
    await expect(history).toHaveAttribute('aria-label', 'ประวัติการสั่ง');
    await page.reload();
    await expect(history).toHaveAttribute('aria-label', 'ประวัติการสั่ง');
    await page.getByTestId('server-app-language-button').click();
    await expect(history).toHaveAttribute('aria-label', 'Order history');
    await expect(page.getByPlaceholder('Phone')).toHaveCount(0);

    const grid = page.getByTestId('pos-product-grid');
    const search = grid.getByPlaceholder('Search menu');
    await search.fill('2*E2E Coffee');
    await search.press('Enter');
    await page.getByPlaceholder('Order notes (optional)').first().fill('From the QR');
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const orders = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json();
    expect(orders.orders).toHaveLength(1);
    expect(orders.orders[0].special_instructions).toBe('From the QR');
    expect(
      orders.orders[0].items.some(
        (item: { product_name: string; quantity: number }) =>
          item.product_name === 'E2E Coffee' && item.quantity === 2,
      ),
    ).toBeTruthy();

    // A second send from the same table adds to the open order rather than opening another.
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    const again = await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json();
    expect(again.orders).toHaveLength(1);

    const priceAlert = page.getByTestId('guest-price-alerts');
    await expect(priceAlert).toHaveCount(0);
    await page.route('**/api/guest/order?*', async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (payload.order?.items?.[0]) {
        payload.order.items[0].saved_price = { entry_id: 1, unit_price: 125, weight: null };
      }
      await route.fulfill({ response, json: payload });
    });
    await expect(priceAlert).toContainText(/The kitchen set E2E Coffee at .*125.* per portion/, {
      timeout: 12_000,
    });

    // The header lists what this table has ordered.
    await page.getByTestId('server-app-history-button').click();
    await expect(
      page.getByTestId('server-app-guest-history-item').filter({ hasText: 'E2E Coffee' }).first(),
    ).toBeVisible();
    await expect(page.getByTestId('server-app-guest-history-item').first()).toContainText(
      'Waiting',
    );
    const guestHistory = page.getByTestId('server-app-guest-history');
    await expect(guestHistory.getByRole('heading', { name: 'Items ordered' })).toBeVisible();
    await expect(page.getByTestId('server-app-guest-history-as-of')).toHaveText(
      /^As of \d{1,2}:\d{2}/,
    );
    await expect(page.getByTestId('server-app-guest-history-item')).toHaveCount(1);
    await expect(page.getByTestId('server-app-guest-history-ordered-by').first()).toHaveText(
      'Ordered by: Guest',
    );
    await expect(page.getByTestId('server-app-guest-history-count')).toHaveText('1 item');
    const footerTotal = await page.getByTestId('server-app-guest-history-total').innerText();
    await page.getByTestId('server-app-guest-bill-button').click();
    await expect(guestHistory.getByRole('heading', { name: 'Bill' })).toBeVisible();
    await expect(page.getByTestId('server-app-guest-bill')).toContainText('E2E Coffee');
    await expect(page.getByTestId('server-app-guest-bill-total')).toHaveText(footerTotal);
    await expect(page.getByTestId('server-app-guest-bill-table')).toHaveText(
      `Table: ${table.name}`,
    );
    await expect(page.getByTestId('server-app-guest-bill-item').first()).toContainText(
      'Ordered by: Guest',
    );
    const proceed = page.getByTestId('server-app-guest-bill-continue');
    await expect(proceed).toBeDisabled();
    await page.getByTestId('server-app-guest-pay-staff').click();
    await expect(page.getByTestId('server-app-guest-pay-staff')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Asking for the bill is confirmed first, since it closes ordering for the table.
    await proceed.click();
    const confirm = page.getByTestId('server-app-guest-bill-confirm');
    await expect(confirm).toContainText("you can't order any more food");
    await confirm.getByTestId('server-app-guest-bill-confirm-cancel').click();
    await expect(confirm).toHaveCount(0);
    await proceed.click();
    await confirm.getByTestId('server-app-guest-bill-confirm-ok').click();
    const requestedModal = page.getByTestId('server-app-guest-bill-requested-modal');
    await expect(requestedModal.getByRole('heading', { name: 'Bill requested' })).toBeVisible();
    await requestedModal.getByTestId('server-app-guest-bill-requested-ok').click();
    await expect(requestedModal).toHaveCount(0);
    await expect(page.getByTestId('server-app-guest-bill-requested')).toContainText(
      'Staff have been notified',
    );
    await expect(proceed).toBeDisabled();
    await expect(proceed).toHaveText('Bill requested');
    // The POS lists the table among those waiting to pay, as for a tableside request.
    const waiting = await (
      await page.request.get(`${E2E_BASE_URL}/api/bill-requests`, { headers: manager() })
    ).json();
    expect(
      waiting.requests.some((request: { id: number }) => request.id === again.orders[0].id),
    ).toBeTruthy();
    await page.getByTestId('server-app-guest-bill-back').click();
    await expect(guestHistory.getByRole('heading', { name: 'Items ordered' })).toBeVisible();
    await page.getByTestId('server-app-guest-history-close').click();
    await expect(guestHistory).toHaveCount(0);
    await expect(page.getByTestId('server-app-awaiting-payment')).toHaveText(
      "The bill has been requested, so this table can't order more.",
    );

    // The Guest account that placed the orders never shows up as staff.
    const ownerHeaders = {
      Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
    };
    const staff = await (
      await page.request.get(`${E2E_BASE_URL}/api/staff`, { headers: ownerHeaders })
    ).json();
    expect(staff.staff.some((member: { name: string }) => member.name === 'Guest')).toBeFalsy();
    const candidates = await (
      await page.request.get(`${E2E_BASE_URL}/api/tables/owner-candidates`, {
        headers: ownerHeaders,
      })
    ).json();
    expect(
      candidates.staff.some((member: { name: string }) => member.name === 'Guest'),
    ).toBeFalsy();
  });

  test('an open page reloads itself when the POS serves a newer frontend, but not over unsent items', async ({
    page,
  }) => {
    const info = await page.request.get(`${E2E_SERVER_APP_BASE_URL}/api/server-app/info`);
    expect((await info.json()).frontend_build).toMatch(/^[0-9a-f]{12}$/);

    let build = 'build-a';
    await page.route('**/api/server-app/info', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), frontend_build: build },
      });
    });
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toBeVisible();
    const mark = () => page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1));
    const marked = () =>
      page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1);
    const comeBack = () =>
      page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(500);
    await mark();

    // The same build leaves the page alone; a new one reloads it.
    await comeBack();
    await page.waitForTimeout(1000);
    expect(await marked()).toBe(true);
    build = 'build-b';
    await comeBack();
    await expect.poll(marked, { timeout: 10000 }).toBe(false);
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toBeVisible();
    // iOS Safari offers to reduce privacy protections after a reload, so the page reopens instead.
    expect(
      await page.evaluate(
        () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type,
      ),
    ).not.toBe('reload');
    expect(new URL(page.url()).search).toContain(table.query);

    // With items waiting to be sent it holds off.
    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await expect(page.getByRole('button', { name: 'Send to kitchen' }).first()).toBeEnabled();
    await mark();
    build = 'build-c';
    await comeBack();
    await page.waitForTimeout(1500);
    expect(await marked()).toBe(true);
  });

  test('customers always see the day theme, and staff get the night theme back after signing in', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.evaluate(() => localStorage.setItem('flo-theme-resolved', 'dark'));
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    const html = page.locator('html');
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toBeVisible();
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);

    await page.getByTestId('server-app-login-button').click();
    await page.getByPlaceholder('Staff code').fill('4242');
    const landing = page.getByTestId('server-app-staff-profile');
    await expect(landing).toBeVisible();
    await landing.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByTestId('server-app-table-qr-button')).toBeVisible();
    await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('the guest label reads ลูกค้า in Thai', async ({ page }) => {
    const table = await createTable(page);
    const setServerLanguage = (value: string) =>
      page.request.put(`${E2E_BASE_URL}/api/settings/language`, {
        headers: manager(),
        data: { value },
      });
    await setServerLanguage('th');
    try {
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
      await page.evaluate(() => {
        const raw = localStorage.getItem('pos-settings');
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = { ...parsed.state, language: 'th' };
        localStorage.setItem('pos-settings', JSON.stringify(parsed));
      });
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
      await expect(page.getByTestId('server-app-guest-name')).toHaveText('ลูกค้า');
    } finally {
      await setServerLanguage('en');
    }
  });

  test('the flag switches languages instantly and the guest service menu keeps four cards with eight reserved rows', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    const flag = page.getByTestId('server-app-language-button');
    await expect(flag).toHaveAttribute('aria-label', 'Change language');
    await flag.click();
    await expect(flag).toHaveAttribute('aria-label', 'เปลี่ยนภาษา');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByTestId('server-app-header-grid-circle').click();
    const menu = page.getByTestId('service-menu');
    await expect(menu.getByRole('heading')).toHaveText('กรุณาเลือกบริการ');
    await expect(menu).toContainText('วันนี้ต้องการรับบริการด้านใดดีค่ะ');
    const cards = menu.getByTestId('service-menu-card');
    await expect(cards).toHaveCount(4);
    for (const card of await cards.all()) {
      expect((await card.boundingBox())?.width).toBeCloseTo(116, 2);
      expect((await card.boundingBox())?.height).toBeCloseTo(116, 2);
    }
    const grid = menu.getByTestId('service-menu-grid');
    expect(
      await grid.evaluate(
        (element) => getComputedStyle(element).gridTemplateRows.split(' ').length,
      ),
    ).toBe(8);
    expect((await grid.boundingBox())?.height).toBeCloseTo(1040, 2);
    await menu.screenshot({ path: test.info().outputPath('service-menu-thai.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await flag.click();
    await expect(flag).toHaveAttribute('aria-label', 'Change language');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByTestId('server-app-header-grid-circle').press('Enter');
    await expect(menu.getByRole('heading')).toHaveText('Please select a service');
    await expect(cards).toHaveText([
      'Request cutlery',
      'Request condiments',
      'Refill drink',
      'Other',
    ]);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('the grey bar unlocks the staff area after three quick taps or a three-second hold', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.clock.install();
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    const service = page.getByTestId('service-menu');
    const handle = service.getByTestId('service-menu-staff-handle');
    const taps = service.locator('[data-testid="service-menu-staff-taps"] [data-active="true"]');
    const staffCode = page.getByPlaceholder('Staff code');
    const staffArea = service.getByTestId('service-menu-staff-area');
    await page.getByTestId('server-app-header-grid-circle').click();
    await expect(service).toContainText(
      'Tap the grey bar above 3 times within 1.5 seconds, or hold it for 3 seconds',
    );

    await handle.hover();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await handle.click();
    await handle.click();
    await expect(taps).toHaveCount(2);
    await page.clock.runFor(1500);
    await expect(taps).toHaveCount(0);
    await handle.click();
    await expect(taps).toHaveCount(1);
    await page.clock.runFor(1600);
    await handle.click();
    await handle.click();
    await expect(taps).toHaveCount(2);
    await expect(staffArea).toHaveCount(0);
    await handle.click();
    await expect(handle).toHaveAttribute('aria-pressed', 'true');
    await expect(staffArea).toContainText('Staff area');
    await expect(staffArea).toContainText('Registered devices');
    await service.screenshot({ path: test.info().outputPath('staff-area-unlocked.png') });
    await staffArea.click();
    await expect(service).toHaveCount(0);
    await expect(staffCode).toBeVisible();
    await page.clock.resume();

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await page.getByTestId('server-app-header-grid-circle').click();
    await handle.hover();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await page.mouse.down();
    await page.clock.runFor(2900);
    await page.mouse.up();
    await expect(staffArea).toHaveCount(0);
    await page.clock.runFor(1600);
    await page.mouse.down();
    await page.clock.runFor(3000);
    await expect(staffArea).toBeVisible();
    await page.mouse.up();
    await expect(staffArea).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(service).toHaveCount(0);
    await page.getByTestId('server-app-header-grid-circle').click();
    await expect(staffArea).toHaveCount(0);
    await expect(handle).toHaveAttribute('aria-pressed', 'false');
  });

  test('signing in shows the staff name and the table list while keeping the QR table', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await page.getByTestId('server-app-header-grid-circle').click();
    const service = page.getByTestId('service-menu');
    await service.getByRole('button', { name: 'Other', exact: true }).click();
    await expect(service.getByRole('heading')).toHaveText('Other');
    const staffTile = service.getByTestId('service-menu-staff');
    const leaveTile = service.getByTestId('service-menu-leave');
    await expect(leaveTile).toBeDisabled();
    const staffBox = (await staffTile.boundingBox())!;
    const leaveBox = (await leaveTile.boundingBox())!;
    expect(leaveBox.x).toBeGreaterThan(staffBox.x);
    expect(leaveBox.y).toBeCloseTo(staffBox.y, 1);
    const exit = service.getByTestId('service-menu-exit');
    expect((await exit.boundingBox())!.y).toBeGreaterThan(staffBox.y + staffBox.height);
    await service.screenshot({ path: test.info().outputPath('other-staff-leave-exit.png') });
    await exit.click();
    await expect(service).toBeHidden();
    await page.getByTestId('server-app-header-grid-circle').click();
    await service.getByRole('button', { name: 'Other', exact: true }).click();
    await service.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(service.getByTestId('service-menu-card')).toHaveCount(4);
    await service.getByRole('button', { name: 'Other', exact: true }).click();
    await service.getByTestId('service-menu-staff').click();
    await expect(service).toHaveCount(0);
    const rejectedLogin = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/login') && response.request().method() === 'POST',
    );
    await page.getByPlaceholder('Staff code').fill('0000');
    expect((await rejectedLogin).status()).toBe(401);
    await expect(page.getByPlaceholder('Staff code')).toBeVisible();
    await expect(page.locator('header')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('flocafe:server-app-token'))).toBeNull();
    await page.getByPlaceholder('Staff code').fill('4242');

    const profile = page.getByTestId('server-app-staff-profile');
    await expect(profile.getByRole('heading', { name: 'Staff profile' })).toBeVisible();
    await expect(profile).toContainText('E2E server');
    await expect(profile).toContainText('Clocked in');
    await profile.getByRole('button', { name: /Preferences/ }).click();
    await profile.getByTestId('staff-font-larger').click();
    await expect(profile.getByTestId('staff-font-scale-value')).toHaveText('110%');
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('110%');
    await profile.getByTestId('staff-font-smaller').click();
    await expect(profile.getByTestId('staff-font-scale-value')).toHaveText('100%');
    await profile.getByRole('button', { name: 'Back', exact: true }).click();
    await profile.getByRole('button', { name: 'Back', exact: true }).click();

    const header = page.locator('header');
    await expect(header).toContainText('E2E server');
    await expect(header.getByTestId('server-app-table-button')).toHaveAttribute(
      'aria-label',
      'Select a table',
    );
    await expect(page.getByTestId('server-app-table-picker')).toBeVisible();
    await expect(header.getByTestId('server-app-table-qr-button')).toHaveClass(/bg-white/);
    await expect(header.getByTestId('server-app-login-button')).toHaveCount(0);
    await expect(header).toContainText(table.name);

    // Signing out returns to the guest view of the same table.
    await logoutServerApp(page);
    await expect(header.getByTestId('server-app-guest-name')).toBeVisible();
    await expect(header).toContainText(table.name);
  });

  test('guests can go back from the sign-in form, and an unknown table asks for sign-in', async ({
    page,
  }) => {
    const table = await createTable(page);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await page.getByTestId('server-app-login-button').click();
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await expect(page.getByTestId('server-app-guest-name')).toBeVisible();

    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=does-not-exist`);
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByTestId('server-app-guest-name')).toHaveCount(0);
  });

  test('the guest API refuses unknown tables and products and keeps staff endpoints closed', async ({
    page,
    request,
  }) => {
    const table = await createTable(page);
    const post = (data: unknown) =>
      request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, { data: data as object });

    expect(
      (await post({ table_id: 'nope', items: [{ product_id: 'x', quantity: 1 }] })).status(),
    ).toBe(404);
    // A table id alone, or with another token, is not enough to order.
    const item = [{ product_id: 'e2e-product', quantity: 1 }];
    expect((await post({ table_id: table.id, items: item })).status()).toBe(410);
    expect(
      (await post({ table_id: table.id, device_token: 'x'.repeat(32), items: item })).status(),
    ).toBe(410);
    const tableOnly = await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/table`, {
      params: { table_id: table.id },
    });
    expect(tableOnly.status()).toBe(410);
    expect(
      (await post({ table_id: table.id, device_token: table.device, items: [] })).status(),
    ).toBe(400);
    expect(
      (
        await post({
          table_id: table.id,
          device_token: table.device,
          items: [{ product_id: 'not-a-product', quantity: 1 }],
        })
      ).status(),
    ).toBe(400);

    for (const path of ['/api/orders', '/api/tables', '/api/customers-search?q=a']) {
      const res = await request.get(`${E2E_SERVER_APP_BASE_URL}${path}`);
      expect(res.status(), `${path} must still need a sign-in`).toBe(401);
    }

    const menu = await (await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/menu`)).json();
    expect(menu.products.length).toBeGreaterThan(0);
    for (const product of menu.products) {
      expect(product).not.toHaveProperty('cost');
    }
  });
});

test('a QR or device token cannot order for another table or after the table is freed', async ({
  page,
  request,
}) => {
  const source = await createTable(page);
  const other = await createTable(page);
  const mismatchedQr = await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/table`, {
    params: { table_id: other.id, t: source.token },
  });
  expect(mismatchedQr.status()).toBe(410);
  const submit = (tableId: string) =>
    request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
      data: {
        table_id: tableId,
        device_token: source.device,
        idempotency_key: 'qa-invalid-table-token',
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
  expect((await submit(other.id)).status()).toBe(410);
  for (const status of ['occupied', 'available']) {
    const updated = await request.patch(`${E2E_BASE_URL}/api/tables/${source.id}/status`, {
      headers: manager(),
      data: { status },
    });
    expect(updated.ok()).toBeTruthy();
  }
  expect((await submit(source.id)).status()).toBe(410);
});

test('three QR lines keep their quantities and notes and use the POS price', async ({
  page,
  request,
}) => {
  const table = await createTable(page);
  const menu = await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/menu`);
  expect(menu.ok()).toBeTruthy();
  const product = (await menu.json()).products.find(
    (entry: { id: string }) => entry.id === 'e2e-product',
  );
  expect(product).toBeTruthy();
  const items = [1, 2, 3].map((quantity) => ({
    product_id: product.id,
    quantity,
    unit_price: 0.01,
    special_instructions: `QR note ${quantity}`,
  }));
  const submitted = await request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
    data: {
      table_id: table.id,
      device_token: table.device,
      idempotency_key: 'qa-three-qr-lines',
      items,
    },
  });
  expect(submitted.status()).toBe(201);
  const orders = await request.get(`${E2E_BASE_URL}/api/orders`, {
    headers: manager(),
    params: { table_id: table.id, type: 'dine_in' },
  });
  expect(orders.ok()).toBeTruthy();
  const [order] = (await orders.json()).orders;
  expect(order.items).toHaveLength(3);
  expect(order.items).toEqual(
    expect.arrayContaining(
      items.map((item) =>
        expect.objectContaining({
          quantity: item.quantity,
          unit_price: product.price,
          special_instructions: item.special_instructions,
        }),
      ),
    ),
  );
});

test('guests at one table ordering at the same moment share one bill, and every order needs a key', async ({
  page,
  request,
}) => {
  const table = await createTable(page);
  const post = (data: Record<string, unknown>) =>
    request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
      data: {
        table_id: table.id,
        device_token: table.device,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
        ...data,
      },
    });

  const keyless = await post({});
  expect(keyless.status()).toBe(400);
  expect((await keyless.json()).code).toBe('idempotency_key_required');

  const run = Math.random().toString(36).slice(2, 10);
  const friend = await joinDevice(request, table.id, table.token);
  const sent = await Promise.all([
    post({ idempotency_key: `guest-${run}-a` }),
    post({ idempotency_key: `guest-${run}-b`, device_token: friend }),
  ]);
  for (const response of sent) expect(response.status()).toBe(201);
  // A retry with a key already used is a replay, not another dish.
  const replays = await Promise.all(
    Array.from({ length: 4 }, () => post({ idempotency_key: `guest-${run}-a` })),
  );
  const firstReceipt = await sent[0].json();
  expect(firstReceipt).toMatchObject({
    success: true,
    idempotency_key: `guest-${run}-a`,
    order_number: expect.any(String),
  });
  for (const replay of replays) {
    expect(replay.status()).toBe(201);
    expect(await replay.json()).toEqual(firstReceipt);
  }

  const orders = (
    await (
      await page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json()
  ).orders as { items: { quantity: number; status: string }[] }[];
  expect(orders).toHaveLength(1);
  expect(orders[0].items.reduce((sum, item) => sum + item.quantity, 0)).toBe(2);
});

test('the QR ordering checkbox in OrderFlow settings closes and reopens ordering from a table QR', async ({
  page,
}) => {
  const table = await createTable(page);
  const owner = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  try {
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    const checkbox = page.getByTestId('settings-qr-ordering');
    await expect(checkbox).toBeChecked();
    await expect(page.getByText('Take orders by QR code')).toBeVisible();
    await checkbox.uncheck();
    await expect(page.getByText('QR ordering turned off')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('settings-qr-ordering')).not.toBeChecked();

    // A guest scanning the table QR is told to ask staff, and the order route refuses.
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await expect(page.getByTestId('server-app-guest-closed')).toContainText(
      'Ordering by QR code is closed',
    );
    const refused = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
      data: {
        table_id: table.id,
        device_token: table.device,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('guest_ordering_disabled');

    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    await expect(page.getByTestId('settings-qr-ordering')).not.toBeChecked();
    await page.getByTestId('settings-qr-ordering').check();
    await expect(page.getByText('QR ordering turned on')).toBeVisible();
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?${table.query}`);
    await expect(page.locator('header').getByTestId('server-app-guest-name')).toHaveText('Guest');
  } finally {
    await page.request.put(`${E2E_BASE_URL}/api/settings/guest_qr_ordering_enabled`, {
      headers: owner,
      data: { value: 'true' },
    });
  }
});

test('table QR links use the public address, and cancelling QR codes in OrderFlow settings retires the ones handed out', async ({
  page,
}) => {
  const table = await createTable(page);
  const owner = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  const reset = () =>
    page.request.put(`${E2E_BASE_URL}/api/settings/guest-qr`, {
      headers: owner,
      data: { public_base_url: '', trusted_proxy: '' },
    });
  try {
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    const network = page.getByTestId('settings-qr-network');
    await expect(network.getByText('Manual setup (your own VPS)')).toHaveCount(0);
    await expect(network.getByLabel('Public address for QR codes')).toHaveCount(0);

    const saved = await page.request.put(`${E2E_BASE_URL}/api/settings/guest-qr`, {
      headers: owner,
      data: { public_base_url: 'https://order.example.com/', trusted_proxy: '' },
    });
    expect((await saved.json()).public_base_url).toBe('https://order.example.com');

    // New QR codes point at the public address.
    const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
      headers: owner,
    });
    const body = await qr.json();
    expect(body.public).toBe(true);
    expect(body.url).toBe(`https://order.example.com/server-standalone/?${table.query}`);

    // Cancelling every QR code makes the one handed out stop working.
    await network.getByRole('button', { name: 'Cancel all table QR codes' }).click();
    await page.getByRole('button', { name: 'Cancel all table QR codes' }).last().click();
    await expect(
      page.getByText('Old QR codes cancelled. Open a new QR from each table.'),
    ).toBeVisible();
    const old = await page.request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/table`, {
      params: { table_id: table.id, t: table.token },
    });
    expect(old.status()).toBe(410);
  } finally {
    await reset();
  }
});

test('pairing with a QR ordering server by code opens a tunnel that serves guests only', async ({
  page,
}) => {
  const table = await createTable(page);
  const owner = { Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}` };
  const relay = await createFakeQrRelay();
  try {
    const paired = await page.request.post(`${E2E_BASE_URL}/api/qr-relay/pair`, {
      headers: owner,
      data: { server_url: relay.url },
    });
    expect(paired.ok(), await paired.text()).toBeTruthy();
    const pairing = await paired.json();
    expect(pairing.pairing.code).toMatch(/^\d{6}$/);
    relay.approve(pairing.pairing.code, {
      storeId: 'e2e-store',
      publicBaseUrl: 'https://e2e.order.example.com',
    });
    const checked = await page.request.post(`${E2E_BASE_URL}/api/qr-relay/pair/check`, {
      headers: owner,
    });
    expect(checked.ok(), await checked.text()).toBeTruthy();
    await relay.waitForTunnel();
    await expect
      .poll(async () => {
        const status = await page.request.get(`${E2E_BASE_URL}/api/qr-relay`, { headers: owner });
        const body = await status.json();
        return { state: body.state, connected: body.connected };
      })
      .toEqual({ state: 'paired', connected: true });

    const qr = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
      headers: owner,
    });
    expect((await qr.json()).url).toBe(
      `https://e2e.order.example.com/server-standalone/?${table.query}`,
    );

    const guestTable = await relay.request(
      'GET',
      `/api/guest/table?table_id=${encodeURIComponent(table.id)}&t=${table.token}`,
    );
    expect(guestTable.status).toBe(200);
    expect(JSON.parse(guestTable.body.toString()).table.id).toBe(table.id);
    const page_ = await relay.request('GET', '/server-standalone/');
    expect(page_.status).toBe(200);
    expect((await relay.request('GET', '/api/orders')).status).toBe(404);
    expect(
      (await relay.request('POST', '/api/auth/login', { body: { email: 'owner@flo.local' } }))
        .status,
    ).toBe(404);

    const disconnected = await page.request.delete(`${E2E_BASE_URL}/api/qr-relay`, {
      headers: owner,
    });
    expect(disconnected.ok(), await disconnected.text()).toBeTruthy();
    expect((await disconnected.json()).state).toBe('unpaired');
    expect(relay.unpaired).toContain('e2e-store');
  } finally {
    await page.request.delete(`${E2E_BASE_URL}/api/qr-relay`, { headers: owner });
    await relay.close();
  }
});

test('the guest site sends no referrer, hides dotfiles and keeps guest bodies small', async ({
  request,
}) => {
  const page = await request.get(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  expect(page.headers()['referrer-policy']).toBe('no-referrer');
  expect((await request.get(`${E2E_SERVER_APP_BASE_URL}/server-standalone/.env`)).status()).toBe(
    404,
  );
  expect((await request.get(`${E2E_SERVER_APP_BASE_URL}/.hidden/index.html`)).status()).toBe(404);
  const big = await request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
    data: { note: 'x'.repeat(150 * 1024) },
  });
  expect(big.status()).toBe(413);
  expect((await big.json()).code).toBe('body_too_large');
});

test('guests share one cached menu, and a menu edit shows on the next read', async ({
  request,
}) => {
  const menuNames = async (): Promise<Record<string, string>> => {
    const menu = await (await request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/menu`)).json();
    return Object.fromEntries(
      (menu.products as { id: string; name: string }[]).map((product) => [
        product.id,
        product.name,
      ]),
    );
  };
  const before = await menuNames();
  const productId = Object.keys(before)[0];
  expect(productId).toBeTruthy();
  const renamed = `${before[productId]} ${Math.random().toString(36).slice(2, 6)}`;
  try {
    const put = await request.put(`${E2E_BASE_URL}/api/products/${productId}`, {
      headers: manager(),
      data: { name: renamed },
    });
    expect(put.ok()).toBeTruthy();
    expect((await menuNames())[productId]).toBe(renamed);
  } finally {
    await request.put(`${E2E_BASE_URL}/api/products/${productId}`, {
      headers: manager(),
      data: { name: before[productId] },
    });
  }
  expect((await menuNames())[productId]).toBe(before[productId]);
});

test('staff hand out a table QR from the POS and the Server App, and it stops working once renewed, ended or the table is freed', async ({
  page,
  request,
}) => {
  const table = await createTable(page);
  const guestTable = (token: string) =>
    request.get(`${E2E_SERVER_APP_BASE_URL}/api/guest/table`, {
      params: { table_id: table.id, t: token },
    });
  const openSession = async () => {
    const res = await request.post(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
      headers: manager(),
    });
    expect(res.ok()).toBeTruthy();
    return new URL((await res.json()).url as string).searchParams.get('t') as string;
  };
  const businessRes = await request.get(`${E2E_BASE_URL}/api/settings/business`, {
    headers: manager(),
  });
  const original = await businessRes.json();
  try {
    await request.put(`${E2E_BASE_URL}/api/settings/business`, {
      headers: manager(),
      data: { ...original, tables_required: true },
    });
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await page.getByRole('button', { name: 'Select Table' }).click();
    await page
      .getByTestId('pos-table-picker')
      .getByRole('button')
      .filter({ hasText: table.name })
      .click();
    await page.getByTestId('cart-table-qr-button').click();

    // Opening the QR again shows the party's code, not a new one.
    const dialog = page.getByTestId('guest-table-qr');
    await expect(dialog.getByRole('img', { name: 'QR' })).toBeVisible();
    await expect(dialog.getByRole('img', { name: 'QR', exact: true })).toBeVisible();
    expect((await guestTable(table.token)).status()).toBe(200);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const newCode = await request.post(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
      headers: manager(),
      data: { renew: true },
    });
    expect(newCode.ok()).toBeTruthy();
    expect((await guestTable(table.token)).status()).toBe(410);
    const renewed = await openSession();
    expect((await guestTable(renewed)).status()).toBe(200);
    const ended = await request.delete(`${E2E_BASE_URL}/api/tables/${table.id}/guest-session`, {
      headers: manager(),
    });
    expect(ended.ok()).toBeTruthy();
    expect((await guestTable(renewed)).status()).toBe(410);

    // Paying, cancelling or moving the table's order frees the table, which ends its QR.
    const seated = await openSession();
    expect((await guestTable(seated)).status()).toBe(200);
    for (const status of ['occupied', 'available']) {
      await request.patch(`${E2E_BASE_URL}/api/tables/${table.id}/status`, {
        headers: manager(),
        data: { status },
      });
    }
    expect((await guestTable(seated)).status()).toBe(410);

    // Managers can see who changed the table's QR; a server cannot.
    const audit = await request.get(`${E2E_BASE_URL}/api/tables/${table.id}/guest-qr-audit`, {
      headers: manager(),
    });
    const actions = ((await audit.json()).events as { action: string; actor_name: string }[])
      .map((event) => event.action)
      .reverse();
    expect(actions.slice(-5)).toEqual(['opened', 'renewed', 'ended', 'opened', 'table_freed']);
    const asServer = await request.get(`${E2E_BASE_URL}/api/tables/${table.id}/guest-qr-audit`, {
      headers: {
        Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
      },
    });
    expect(asServer.status()).toBe(403);
    await setEnglish(page);
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${table.id}&t=${seated}`);
    await expect(page.getByTestId('server-app-guest-expired')).toBeVisible();
    await expect(page.getByText('This QR code has expired')).toBeVisible();

    // The Server App hands out the same QR for the table a server is on.
    await page.evaluate(
      ([key, token]) => localStorage.setItem(key, token),
      ['flocafe:server-app-token', getE2eToken('e2e-server', 'server@flo.local', 'server')],
    );
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${table.id}`);
    await page.getByTestId('server-app-table-qr-button').click();
    await expect(page.getByTestId('guest-table-qr').getByRole('img', { name: 'QR' })).toBeVisible();
  } finally {
    await request.put(`${E2E_BASE_URL}/api/settings/business`, {
      headers: manager(),
      data: original,
    });
  }
});

test('a table sticker joins after a tap, waits for staff to unlock a closed table, and friends share the bill', async ({
  page,
  request,
}) => {
  const newTable = async () => {
    const name = `ST ${Math.random().toString(36).slice(2, 7)}`;
    const created = await request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: manager(),
      data: { number: name, capacity: 2 },
    });
    expect(created.ok()).toBeTruthy();
    return { name, id: (await created.json()).table.id as string };
  };
  const table = await newTable();
  const declined = await newTable();
  const stickers = (
    await (
      await request.post(`${E2E_BASE_URL}/api/tables/guest-stickers`, {
        headers: manager(),
        data: {},
      })
    ).json()
  ).stickers as { id: string; url: string }[];
  const stickerOf = (id: string) =>
    new URL(stickers.find((s) => s.id === id)!.url).searchParams.get('s') as string;
  const sticker = stickerOf(table.id);
  const join = (data: Record<string, unknown>) =>
    request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/join`, {
      data: { table_id: table.id, sticker, ...data },
    });

  // Without a tap nothing joins; the tap asks staff to open the closed table.
  expect((await join({})).status()).toBe(409);
  expect((await join({ sticker: 'x'.repeat(22) })).status()).toBe(410);
  await setEnglish(page);
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${table.id}&s=${sticker}`);
  await expect(page.getByTestId('server-app-guest-tap')).toContainText(table.name);
  await page.getByTestId('server-app-guest-start').click();
  await expect(page.getByTestId('server-app-guest-waiting')).toBeVisible();

  const staff = await page.context().newPage();
  await staff.goto(`${E2E_BASE_URL}/auth/login`);
  await staff.locator('#email').fill('manager@flo.local');
  await staff.locator('#password').fill(E2E_PASSWORD);
  await staff.locator('button[type="submit"]').click();
  await staff.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
  const unlock = staff.getByTestId('guest-alert-unlock_request').filter({ hasText: table.name });
  await expect(unlock).toContainText('guest scanned the QR');
  await unlock.getByTestId('guest-alert-approve').click();
  await expect(unlock).toHaveCount(0);
  const unlocked = await request.get(`${E2E_BASE_URL}/api/tables/${table.id}/guest-qr-audit`, {
    headers: manager(),
  });
  expect((await unlocked.json()).events[0]).toMatchObject({ action: 'unlocked' });
  // The waiting phone joins by itself, and keeps its place after a reload.
  await expect(page.locator('header').getByTestId('server-app-guest-name')).toHaveText('Guest', {
    timeout: 10000,
  });
  await page.reload();
  await expect(page.locator('header').getByTestId('server-app-guest-name')).toHaveText('Guest');

  // A friend scanning the same sticker joins the open table straight away.
  const friendJoin = await join({});
  expect(friendJoin.status()).toBe(200);
  const friend = (await friendJoin.json()).device_token as string;

  const run = Math.random().toString(36).slice(2, 10);
  const order = (key: string, quantity: number) =>
    request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/order`, {
      data: {
        table_id: table.id,
        device_token: friend,
        idempotency_key: `sticker-${run}-${key}`,
        items: [
          { product_id: 'e2e-product', quantity },
          { product_id: 'e2e-product', quantity, special_instructions: 'b' },
        ],
      },
    });
  expect((await order('a', 50)).status()).toBe(201);
  const cooled = await order('b', 1);
  expect(cooled.status()).toBe(429);
  expect((await cooled.json()).code).toBe('order_cooldown');
  await page.waitForTimeout(5200);
  // Past the item limit the order waits for staff, however often it is sent.
  expect((await order('c', 30)).status()).toBe(202);
  expect((await order('c', 30)).status()).toBe(202);
  const held = staff.getByTestId('guest-alert-order_held').filter({ hasText: table.name });
  await expect(held).toContainText('waiting for approval');
  await held.getByTestId('guest-alert-approve').click();
  await expect(staff.getByText('Order sent to the kitchen')).toBeVisible();
  await expect(held).toHaveCount(0);
  expect((await order('c', 30)).status()).toBe(201);

  const orders = (
    await (
      await request.get(`${E2E_BASE_URL}/api/orders`, {
        headers: manager(),
        params: { table_id: table.id, type: 'dine_in', per_page: 5 },
      })
    ).json()
  ).orders as { items: { quantity: number }[] }[];
  expect(orders).toHaveLength(1);
  expect(orders[0].items.reduce((sum, item) => sum + item.quantity, 0)).toBe(160);

  // A request staff turn down tells that phone so.
  const ask = () =>
    request.post(`${E2E_SERVER_APP_BASE_URL}/api/guest/join`, {
      data: { table_id: declined.id, sticker: stickerOf(declined.id), unlock_key: `ask-${run}` },
    });
  expect((await ask()).status()).toBe(202);
  const turnDown = staff.getByTestId('guest-alert-unlock_request').filter({
    hasText: declined.name,
  });
  await turnDown.getByTestId('guest-alert-dismiss').click();
  await expect(turnDown).toHaveCount(0);
  const answer = await ask();
  expect(answer.status()).toBe(409);
  expect((await answer.json()).code).toBe('unlock_declined');
  await staff.close();
});
