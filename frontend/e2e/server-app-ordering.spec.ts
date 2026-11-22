import { test, expect, Locator, Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables, logoutServerApp } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

/** Sent E2E Coffee rows on the current ticket with the given quantity. */
function sentCoffee(scope: Page | Locator, quantity: number): Locator {
  return scope
    .getByTestId('server-app-ticket-item')
    .filter({ hasText: 'E2E Coffee' })
    .filter({ hasText: `x ${quantity}` });
}

async function openServerApp(page: Page, serverToken: string): Promise<void> {
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, tok]) => {
      localStorage.setItem(key, tok);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, serverToken],
  );
  await page.reload();
}

async function pickTable(page: Page, tableName: string): Promise<void> {
  await openServerAppTables(page);
  await page.getByRole('button', { name: new RegExp(tableName) }).click();
}

test.describe('Server App tableside ordering', () => {
  test('the flag switches languages instantly and the service menu keeps four cards with eight reserved rows', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openServerApp(page, getE2eToken('e2e-server', 'server@flo.local', 'server'));
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

  test('staff see no table label at the top and the shop logo sits higher', async ({ page }) => {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: {
        Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
      },
      data: { number: `Header ${Date.now()}`, capacity: 2 },
    });
    expect(table.ok()).toBeTruthy();
    await openServerApp(page, getE2eToken('e2e-server', 'server@flo.local', 'server'));
    const coverSize = await page.evaluate(async () => {
      const image = new Image();
      image.src = '/images/server-app-cover-1920x1080.jpg';
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    expect(coverSize).toEqual([1920, 1080]);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByTestId('server-app-table-label')).toHaveCount(0);
      await expect(page.getByTestId('server-app-header-table')).toHaveCount(0);
      const circles = page.getByTestId('server-app-header-circles');
      const circleBox = (await circles.boundingBox())!;
      const headerBox = (await page.getByTestId('server-app-header').boundingBox())!;
      const logoBox = (await page.getByTestId('server-app-header-logo-frame').boundingBox())!;
      expect(logoBox.y - headerBox.y).toBe(41);
      expect(circleBox.width).toBe(130);
      expect(circleBox.y - headerBox.y).toBe(7);
      expect(headerBox.x + headerBox.width - circleBox.x - circleBox.width).toBe(12);
      const staffName = page.getByTestId('server-app-staff-name');
      await expect(staffName).toHaveText('E2E server');
      await expect(staffName).toHaveCSS('color', 'rgb(255, 255, 255)');
      const staffNameBox = (await staffName.boundingBox())!;
      expect(circleBox.x - staffNameBox.x - staffNameBox.width).toBe(12);
      const flagBox = (await circles
        .getByTestId('server-app-language-button')
        .locator('svg')
        .boundingBox())!;
      expect(flagBox.width).toBeCloseTo(21.6, 1);
      expect(flagBox.height).toBeCloseTo(21.6, 1);
      await expect(circles.getByTestId('server-app-header-empty-circle')).toHaveCount(0);
      const gridCircle = circles.getByTestId('server-app-header-grid-circle');
      expect((await gridCircle.boundingBox())!.x - circleBox.x).toBe(92);
      await expect(gridCircle.locator('svg')).toBeVisible();
      expect((await gridCircle.locator('svg').boundingBox())!.width).toBe(18);
      const theme = circles.getByTestId('server-app-theme-button');
      const themeBox = (await theme.boundingBox())!;
      expect((await theme.locator('svg').boundingBox())!.width).toBeCloseTo(19.8, 1);
      expect(themeBox.x - circleBox.x).toBe(46);
      const pressed = await theme.getAttribute('aria-pressed');
      await theme.click();
      await expect(theme).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
      await theme.click();
      await expect(theme).toHaveAttribute('aria-pressed', pressed ?? 'false');
      await page.mouse.move(0, 0);
      for (const circle of await circles.locator(':scope > span, button').all()) {
        expect((await circle.boundingBox())?.width).toBe(38);
        expect((await circle.boundingBox())?.height).toBe(38);
        await expect(circle).toHaveCSS('background-color', / 0\.85\)$|, 0\.85\)$/);
      }
      await page
        .getByTestId('server-app-header')
        .screenshot({ path: test.info().outputPath(`header-${width}.png`) });
      // The bottom row's Select Table opens the tables.
      await page.getByTestId('server-app-table-button').click();
      await expect(page.getByTestId('server-app-table-picker')).toBeVisible();
      await expect(page.getByPlaceholder('Staff name')).toHaveCount(0);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByTestId('server-app-table-button')).toBeVisible();
    }
  });

  test('the empty ticket returns to the menu on mobile', async ({ page }) => {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: {
        Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
      },
      data: { number: `Empty ticket ${Date.now()}`, capacity: 2 },
    });
    expect(table.ok()).toBeTruthy();
    await page.request.put(`${E2E_BASE_URL}/api/settings/language`, {
      headers: {
        Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
      },
      data: { value: 'en' },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openServerApp(page, getE2eToken('e2e-server', 'server@flo.local', 'server'));
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.getByTestId('server-app-cart-button').click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Tap menu items to add them here.' }).click();
    await expect(drawer).toBeHidden();
    await page.getByTestId('pos-product-grid').getByPlaceholder('Search menu').fill('E2E Coffee');
    await expect(page.getByTestId('pos-product-grid').getByPlaceholder('Search menu')).toHaveValue(
      'E2E Coffee',
    );
  });

  test('sends the order note with the ticket from the shared POS product grid', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };
    await page.request.put(`${E2E_BASE_URL}/api/settings/language`, {
      headers,
      data: { value: 'en' },
    });

    const tableName = `Notes ${Date.now()}`;
    const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableRes.ok()).toBeTruthy();
    const { table } = await tableRes.json();

    await openServerApp(page, serverToken);
    await pickTable(page, tableName);

    const grid = page.getByTestId('pos-product-grid');
    await expect(grid.getByPlaceholder('Search menu')).toBeVisible();
    const search = grid.getByPlaceholder('Search menu');
    await search.fill('2*E2E Coffee');
    await search.press('Enter');

    const note = 'Window seat, birthday';
    await page.getByPlaceholder('Order notes (optional)').first().fill(note);
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    const ordersRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: table.id, type: 'dine_in', per_page: 1 },
    });
    expect(ordersRes.ok()).toBeTruthy();
    const { orders } = await ordersRes.json();
    expect(orders[0]?.special_instructions).toBe(note);
    expect(
      orders[0]?.items?.some(
        (item: { product_name: string; quantity: number }) =>
          item.product_name === 'E2E Coffee' && item.quantity === 2,
      ),
    ).toBeTruthy();
  });

  test('sending an order requests only a kitchen ticket without opening browser print', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableName = `NoBrowserPrint ${Date.now()}`;
    const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableRes.ok()).toBeTruthy();

    await page.addInitScript(() => {
      const win = window as unknown as { __browserPrintCalls?: number };
      win.__browserPrintCalls = 0;
      window.print = () => {
        win.__browserPrintCalls = (win.__browserPrintCalls ?? 0) + 1;
      };
      const origOpen = window.open.bind(window);
      window.open = (...args: Parameters<typeof window.open>) => {
        win.__browserPrintCalls = (win.__browserPrintCalls ?? 0) + 1;
        return origOpen(...args);
      };
    });

    let kotCalls = 0;
    let billCalls = 0;
    await page.route('**/api/printers/print-kot', async (route) => {
      kotCalls += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No default printer configured' }),
      });
    });
    await page.route('**/api/printers/print-bill', async (route) => {
      billCalls += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No default printer configured' }),
      });
    });

    await openServerApp(page, serverToken);
    await page.getByRole('button', { name: new RegExp(tableName) }).click();

    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    const kotResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/printers/print-kot') && res.status() === 400,
    );
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByText('Order sent', { exact: true }).first()).toBeVisible();

    await kotResponsePromise;
    await expect(
      page.waitForRequest('**/api/printers/print-bill', { timeout: 1000 }),
    ).rejects.toThrow('Timeout');

    expect(kotCalls).toBe(1);
    expect(billCalls).toBe(0);

    const browserPrintCalls = await page.evaluate(
      () => (window as unknown as { __browserPrintCalls?: number }).__browserPrintCalls ?? 0,
    );
    expect(browserPrintCalls).toBe(0);
    await expect(page.getByText('No default printer configured')).toHaveCount(0);
    await expect(page.getByText("Order sent, but the kitchen ticket didn't print")).toHaveCount(0);
    await expect(page.getByText("Order sent, but the bill didn't print")).toHaveCount(0);
  });

  test('explains that tables are required when none are set up', async ({ page }) => {
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    await page.route('**/api/tables?*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"tables":[]}' }),
    );

    await openServerApp(page, serverToken);

    await expect(page.getByRole('heading', { name: 'No tables set up' })).toBeVisible();
    await expect(page.getByTestId('pos-product-grid')).toHaveCount(0);
  });

  test('the table button opens the card picker without a dropdown or staff sign-in', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const tableName = `Picker ${Date.now()}`;
    const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: { Authorization: `Bearer ${managerToken}` },
      data: { number: tableName, capacity: 2 },
    });
    expect(created.ok()).toBeTruthy();

    await page.setViewportSize({ width: 390, height: 844 });
    await openServerApp(page, serverToken);
    const picker = page.getByTestId('server-app-table-button');
    await expect(picker).toHaveAttribute('aria-label', 'Select a table');
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(tableName) }).click();
    await expect(page.locator('header')).toContainText(tableName);
    // Select Table names the picked table in bold; staff get no table label at the top.
    const pickedName = picker.getByTestId('server-app-table-button-name');
    await expect(pickedName).toHaveText(tableName);
    await expect(pickedName).toHaveCSS('font-weight', '700');
    await expect(page.getByTestId('server-app-table-label')).toHaveCount(0);
    // Picking a table folds the list away.
    await expect(page.getByRole('heading', { name: 'Tables' })).toHaveCount(0);

    const tokenBefore = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
    await picker.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('server-app-table-picker')).toBeVisible();
    await expect(page.getByPlaceholder('Staff name')).toHaveCount(0);
    const option = page
      .getByTestId('server-app-table-picker')
      .getByRole('button', { name: new RegExp(tableName) });
    await option.focus();
    await option.press('Enter');
    await expect(page.getByTestId('server-app-table-picker')).toBeHidden();
    expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBe(tokenBefore);
    await expect(page.locator('header')).toContainText(tableName);
    await openServerAppTables(page);
    const qr = page.getByTestId('server-app-table-qr-button');
    await expect(qr).toHaveCSS('background-color', / 0\.85\)$|, 0\.85\)$/);
    await expect(qr).toHaveCSS('border-width', '0px');
    await expect(qr).toHaveCSS('opacity', '1');
    // The bottom buttons sit as far from the cover's bottom edge as the round buttons from its top.
    const cover = (await page.locator('header > div').first().boundingBox())!;
    const flag = (await page.getByTestId('server-app-language-button').boundingBox())!;
    for (const button of [qr, page.getByTestId('server-app-history-button')]) {
      const box = (await button.boundingBox())!;
      expect(cover.y + cover.height - (box.y + box.height)).toBeCloseTo(flag.y - cover.y, 0);
    }
    // With no table label for staff, the shop logo sits 41px below the cover's top.
    const logo = (await page.getByTestId('server-app-header-logo-frame').boundingBox())!;
    expect(logo.y - cover.y).toBeCloseTo(41, 0);
    await qr.hover();
    await expect(qr).toHaveCSS('opacity', '1');
    await expect(qr).toHaveCSS('color', 'rgb(17, 17, 17)');
    await expect(qr.locator('svg')).toHaveCSS('color', 'rgb(234, 88, 12)');
    const label = page.getByTestId('server-app-qr-label');
    const topFont = await picker.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight];
    });
    expect(
      await label.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight];
      }),
    ).toEqual(topFont);
    await expect(label).toHaveText('Show QR');
    await qr.click();
    await expect(page.getByTestId('guest-table-qr')).toBeVisible();
    await page
      .getByTestId('guest-table-qr')
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    // A tablet keeps the table list beside the menu and offers the dropdown in the header.
    for (const size of [
      { width: 1024, height: 768 },
      { width: 820, height: 1180 },
    ]) {
      await page.setViewportSize(size);
      await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
      await expect(page.getByTestId('server-app-table-button')).toBeVisible();
      await expect(page.getByTestId('server-app-emergency-button')).toHaveCount(0);
      await expect(page.getByRole('button', { name: new RegExp(tableName) })).toBeVisible();
    }
  });

  test('fits mobile viewports without horizontal overflow', async ({ page }) => {
    const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: {
        Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
      },
      data: { number: `Responsive ${Date.now()}`, capacity: 2 },
    });
    expect(table.ok()).toBeTruthy();
    const serverToken = getE2eToken(
      'e2e-server',
      `server-${Date.now()}-${Math.random()}@flo.local`,
      'server',
    );
    const viewports = [320, 375, 390, 430];

    await openServerApp(page, serverToken);
    for (const width of viewports) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByTestId('pos-product-grid')).toBeVisible();

      // Select Table sits in the bottom row with order history and Show QR; language and theme sit on top.
      const header = page.locator('header');
      const tableButton = header.getByTestId('server-app-table-button');
      const logoutButton = header.getByTestId('server-app-table-qr-button');
      const languageButton = header.getByTestId('server-app-language-button');
      const historyButton = header.getByTestId('server-app-history-button');
      await expect(tableButton).toBeVisible();
      await expect(logoutButton).toBeVisible();
      await expect(header.getByRole('button')).toHaveCount(7);
      await expect(header.getByRole('img', { name: 'Flo' })).toHaveCount(0);

      for (const button of [tableButton, logoutButton, languageButton, historyButton]) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(button === languageButton ? 38 : 44);
        expect(box!.height).toBeGreaterThanOrEqual(button === languageButton ? 38 : 36);
      }

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasOverflow).toBeFalsy();
    }

    // The tablet header retains the selector and fits beside language, theme, history and session.
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('header').getByRole('button')).toHaveCount(7);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBeFalsy();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();

    await logoutServerApp(page);
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('on a phone, editing an item from the ticket sheet shows the edit dialog on top and returns to the sheet', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const tableName = `Edit sheet ${Date.now()}`;
    const created = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers: { Authorization: `Bearer ${managerToken}` },
      data: { number: tableName, capacity: 2 },
    });
    expect(created.ok()).toBeTruthy();

    await page.setViewportSize({ width: 390, height: 844 });
    await openServerApp(page, serverToken);
    await pickTable(page, tableName);
    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByTestId('server-app-cart-button').click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Edit', exact: true }).click();

    const instructions = page.getByPlaceholder('e.g., no onions, extra spicy...');
    await expect(instructions).toBeVisible();
    const onTop = () =>
      instructions.evaluate((input) => {
        const box = input.getBoundingClientRect();
        return (
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input
        );
      });
    await expect.poll(onTop).toBe(true);
    await instructions.fill('extra spicy');
    await page.getByRole('button', { name: /^Save/ }).click();

    await expect(instructions).toHaveCount(0);
    await expect(page.getByRole('dialog').getByText('extra spicy')).toBeVisible();
  });

  test('freezes draft controls, pre-opened customizer, and table switching during a delayed send without blocking on printing', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableAName = `Freeze A ${Date.now()}`;
    const tableBName = `Freeze B ${Date.now()}`;
    const [tableARes, tableBRes] = await Promise.all([
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableAName, capacity: 2 },
      }),
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableBName, capacity: 2 },
      }),
    ]);
    expect(tableARes.ok()).toBeTruthy();
    expect(tableBRes.ok()).toBeTruthy();
    const { table: tableA } = await tableARes.json();
    const { table: tableB } = await tableBRes.json();

    await openServerApp(page, serverToken);
    await pickTable(page, tableAName);

    const grid = page.getByTestId('pos-product-grid');
    const search = grid.getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    const notesInput = page.getByPlaceholder('Order notes (optional)').first();
    await notesInput.fill('Initial note');

    // Keep the table list open so the frozen table buttons can be checked during Send.
    await expect(page.getByTestId('server-app-table-picker')).toBeVisible();

    // Open the customizer before Send is clicked so its callback is live when Send starts.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(page.getByPlaceholder('e.g., no onions, extra spicy...')).toBeVisible();
    await page.getByRole('button', { name: '3', exact: true }).click();

    let markOrderPostInFlight!: () => void;
    const orderPostInFlight = new Promise<void>((resolve) => {
      markOrderPostInFlight = resolve;
    });
    let releaseOrderPost!: () => void;
    const orderPostGate = new Promise<void>((resolve) => {
      releaseOrderPost = resolve;
    });

    await page.route('**/api/orders', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      markOrderPostInFlight();
      await orderPostGate;
      await route.continue();
    });

    const kotPrintPayloads: Array<{
      orderId: number;
      items: Array<{ id: number; quantity: number }>;
    }> = [];
    let releaseKotPrint!: () => void;
    const kotPrintGate = new Promise<void>((resolve) => {
      releaseKotPrint = resolve;
    });
    let firstKotGateUsed = false;
    await page.route('**/api/printers/print-kot', async (route) => {
      kotPrintPayloads.push(route.request().postDataJSON());
      if (!firstKotGateUsed) {
        firstKotGateUsed = true;
        await kotPrintGate;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    // Trigger Send while the pre-opened customizer modal is still mounted.
    const sendButton = page.getByRole('button', { name: 'Send to kitchen' }).first();
    await sendButton.dispatchEvent('click');
    await orderPostInFlight;

    await expect(page.getByRole('button', { name: 'Sending...' }).first()).toBeDisabled();

    // Submitting the pre-opened customizer while Send is in flight must not mutate the draft.
    await page.getByRole('button', { name: /Save changes/ }).click();

    const productCard = grid.getByTestId('pos-product-card').first();
    const removeButton = page.getByRole('button', { name: 'Remove item' }).first();
    const editButton = page.getByRole('button', { name: 'Edit', exact: true }).first();
    const tableBButton = page.getByRole('button', { name: new RegExp(tableBName) });
    const tablePickerButton = page.getByTestId('server-app-table-button');

    await expect(productCard).toBeDisabled();
    await expect(removeButton).toBeDisabled();
    await expect(editButton).toBeDisabled();
    await expect(tableBButton).toBeDisabled();
    // Table selection stays frozen in both the dropdown and the table list.
    await expect(tablePickerButton).toBeDisabled();
    await expect(notesInput).toBeDisabled();

    // Bypassing disabled UI via synthetic clicks or search Enter must also be blocked by the in-flight ref.
    await productCard.dispatchEvent('click');
    await removeButton.dispatchEvent('click');
    await editButton.dispatchEvent('click');
    await tableBButton.dispatchEvent('click');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    await expect(page.locator('header')).toContainText(tableAName);
    await expect(notesInput).toHaveValue('Initial note');

    // Release the order POST while print-kot is still blocked; Send must complete without waiting on printing.
    releaseOrderPost();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    await expect(page.getByText('Tap menu items to add them here.').first()).toBeVisible();
    // Sending clears the table; picking it again shows what was sent.
    await expect(page.getByTestId('server-app-header-table')).toContainText('Table —');
    await pickTable(page, tableAName);
    await expect(sentCoffee(page, 1).first()).toBeVisible();
    releaseKotPrint();

    // Now that the first send finished and unlocked the UI, adding and sending a second item must succeed.
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Add to order' }).first().click();
    await expect(page.getByTestId('server-app-header-table')).toContainText('Table —');
    await pickTable(page, tableAName);
    await expect(sentCoffee(page.locator('main'), 1)).toHaveCount(2);
    await expect.poll(() => kotPrintPayloads.length).toBe(2);
    expect(kotPrintPayloads[0]?.items).toHaveLength(1);
    expect(kotPrintPayloads[1]?.items).toHaveLength(1);
    expect(kotPrintPayloads[1]?.items[0]?.id).not.toBe(kotPrintPayloads[0]?.items[0]?.id);

    const [ordersARes, ordersBRes] = await Promise.all([
      page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableA.id, type: 'dine_in', per_page: 5 },
      }),
      page.request.get(`${E2E_BASE_URL}/api/orders`, {
        headers,
        params: { table_id: tableB.id, type: 'dine_in', per_page: 5 },
      }),
    ]);
    const { orders: ordersA } = await ordersARes.json();
    const { orders: ordersB } = await ordersBRes.json();
    const totalCoffeeQty = (ordersA[0]?.items || [])
      .filter((item: { product_name: string }) => item.product_name === 'E2E Coffee')
      .reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);
    expect(totalCoffeeQty).toBe(2);
    expect(ordersB).toHaveLength(0);
  });

  test('double Send in the same tick creates only one order mutation', async ({ page }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableName = `DoubleSend ${Date.now()}`;
    const tableRes = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableRes.ok()).toBeTruthy();
    const { table } = await tableRes.json();

    await openServerApp(page, serverToken);
    await pickTable(page, tableName);

    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');

    let postCalls = 0;
    await page.route('**/api/orders', async (route) => {
      if (route.request().method() === 'POST') {
        postCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await route.continue();
    });

    const sendButton = page.getByRole('button', { name: 'Send to kitchen' }).first();
    await sendButton.evaluate((btn: HTMLButtonElement) => {
      btn.click();
      btn.click();
    });

    await expect(page.getByText('Order sent').first()).toBeVisible();
    expect(postCalls).toBe(1);

    const ordersRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: table.id, type: 'dine_in', per_page: 5 },
    });
    const { orders } = await ordersRes.json();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.items).toHaveLength(1);
    expect(orders[0]?.items[0]?.quantity).toBe(1);
  });

  test('retains draft and idempotency retry key after a failed send, and ignores stale table order responses', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };

    const tableAName = `Retry A ${Date.now()}`;
    const tableBName = `Retry B ${Date.now()}`;
    const [tableARes, tableBRes] = await Promise.all([
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableAName, capacity: 2 },
      }),
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableBName, capacity: 2 },
      }),
    ]);
    expect(tableARes.ok()).toBeTruthy();
    expect(tableBRes.ok()).toBeTruthy();
    const { table: tableA } = await tableARes.json();
    const { table: tableB } = await tableBRes.json();

    await openServerApp(page, serverToken);
    await pickTable(page, tableAName);

    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('2*E2E Coffee');
    await search.press('Enter');

    const notesInput = page.getByPlaceholder('Order notes (optional)').first();
    await notesInput.fill('Retry note');

    const idempotencyKeys: string[] = [];
    const postPaths: string[] = [];
    let simulateLostCommitResponse = true;
    await page.route('**/api/orders*', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const url = new URL(route.request().url());
      postPaths.push(url.pathname);
      const key = route.request().headers()['idempotency-key'] || '';
      idempotencyKeys.push(key);
      if (simulateLostCommitResponse) {
        simulateLostCommitResponse = false;
        const committed = await route.fetch();
        expect(committed.ok()).toBeTruthy();
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary failure after commit' }),
        });
        return;
      }
      await route.continue();
    });

    // First send commits on backend, but response is lost: draft and notes must remain intact.
    await page.getByRole('button', { name: 'Send to kitchen' }).first().click();
    await expect(page.getByRole('button', { name: 'Send to kitchen' }).first()).toBeEnabled();
    await expect(notesInput).toHaveValue('Retry note');
    await expect(page.getByRole('button', { name: 'Remove item' }).first()).toBeEnabled();

    // Switch away to Table B and back to Table A so the newly created order loads while the draft remains.
    const reloadTableAOrder = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`),
    );
    await pickTable(page, tableBName);
    await pickTable(page, tableAName);
    await reloadTableAOrder;
    await expect(sentCoffee(page, 2).first()).toBeVisible();

    // Retrying the unmodified draft must replay the original POST /api/orders with the same key instead of appending a second time.
    await page.getByRole('button', { name: 'Add to order' }).first().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    expect(postPaths).toEqual(['/api/orders', '/api/orders']);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBeTruthy();
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);

    const ordersAAfterRetryRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: tableA.id, type: 'dine_in', per_page: 5 },
    });
    const { orders: ordersAAfterRetry } = await ordersAAfterRetryRes.json();
    expect(ordersAAfterRetry).toHaveLength(1);
    expect(ordersAAfterRetry[0]?.items).toHaveLength(1);
    expect(ordersAAfterRetry[0]?.items[0]?.quantity).toBe(2);

    // Delay a subsequent GET /api/orders for Table A, wait for interception before switching back to Table B,
    // and wait for its released response to finish before asserting Table A's order does not render on Table B.
    let markTableAOrderGetIntercepted!: () => void;
    const tableAOrderGetIntercepted = new Promise<void>((resolve) => {
      markTableAOrderGetIntercepted = resolve;
    });
    let releaseTableAOrderGet!: () => void;
    const tableAOrderGetGate = new Promise<void>((resolve) => {
      releaseTableAOrderGet = resolve;
    });
    let failNextTableALookup = false;
    let delayedOnce = false;
    await page.route('**/api/orders?*', async (route) => {
      const url = route.request().url();
      if (failNextTableALookup && url.includes(`table_id=${tableA.id}`)) {
        failNextTableALookup = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Lookup failed' }),
        });
        return;
      }
      if (!delayedOnce && url.includes(`table_id=${tableA.id}`)) {
        delayedOnce = true;
        markTableAOrderGetIntercepted();
        await tableAOrderGetGate;
      }
      await route.continue();
    });

    const firstTableBOrderGet = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableB.id}`),
    );
    await pickTable(page, tableBName);
    await firstTableBOrderGet;

    const delayedTableAOrderGet = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`),
    );
    await pickTable(page, tableAName);
    await tableAOrderGetIntercepted;

    const secondTableBOrderGet = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableB.id}`),
    );
    await pickTable(page, tableBName);
    await secondTableBOrderGet;

    releaseTableAOrderGet();
    const staleTableAResponse = await delayedTableAOrderGet;
    expect(staleTableAResponse.ok()).toBeTruthy();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    await expect(page.locator('header')).toContainText(tableBName);
    await expect(sentCoffee(page, 2)).toHaveCount(0);

    // Prepare a new draft on Table B, then return to occupied Table A while its lookup fails:
    // Send must remain blocked until Table A's lookup succeeds so it cannot create a separate order.
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await expect(page.getByRole('button', { name: 'Send to kitchen' }).first()).toBeEnabled();

    failNextTableALookup = true;
    const failedTableALookup = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`),
    );
    await pickTable(page, tableAName);
    await failedTableALookup;

    const sendOnTableAButton = page.getByRole('button', { name: 'Send to kitchen' }).first();
    await expect(sendOnTableAButton).toBeDisabled();
    await sendOnTableAButton.dispatchEvent('click');
    expect(postPaths).toHaveLength(2);

    // Selecting Table A again retries its order lookup and switches the action to append ("Add to order").
    const recoveredTableALookup = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableA.id}`) &&
        res.ok(),
    );
    await pickTable(page, tableAName);
    await recoveredTableALookup;
    await expect(page.getByRole('button', { name: 'Add to order' }).first()).toBeEnabled();

    const ordersBRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: tableB.id, type: 'dine_in', per_page: 5 },
    });
    const { orders: ordersB } = await ordersBRes.json();
    expect(ordersB).toHaveLength(0);
  });

  test('refreshes move-table permission, closes mobile ticket drawer when opening MoveTableModal, and preserves pending send retry key across a table move', async ({
    page,
  }) => {
    const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
    const headers = { Authorization: `Bearer ${managerToken}` };
    await page.request.put(`${E2E_BASE_URL}/api/settings/language`, {
      headers,
      data: { value: 'en' },
    });

    const stamp = Date.now();
    const tableSrcName = `MoveSrc ${stamp}`;
    const tableDstName = `MoveDst ${stamp}`;
    const [srcRes, dstRes] = await Promise.all([
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableSrcName, capacity: 4 },
      }),
      page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number: tableDstName, capacity: 4 },
      }),
    ]);
    expect(srcRes.ok()).toBeTruthy();
    expect(dstRes.ok()).toBeTruthy();
    const { table: tableSrc } = await srcRes.json();
    const { table: tableDst } = await dstRes.json();

    // Start on a phone viewport with tables.orders.move initially omitted from /api/auth/me.
    await page.setViewportSize({ width: 390, height: 844 });
    let grantMovePermission = false;
    let delayNextAuthMe = false;
    let markAuthMeIntercepted: () => void = () => {};
    let releaseAuthMe: () => void = () => {};
    const authMeIntercepted = new Promise<void>((resolve) => {
      markAuthMeIntercepted = resolve;
    });
    const authMeGate = new Promise<void>((resolve) => {
      releaseAuthMe = resolve;
    });
    await page.route('**/api/auth/me', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (delayNextAuthMe) {
        delayNextAuthMe = false;
        markAuthMeIntercepted();
        await authMeGate;
      }
      if (!grantMovePermission && Array.isArray(json?.user?.permission_ids)) {
        json.user.permission_ids = json.user.permission_ids.filter(
          (id: string) => id !== 'tables.orders.move',
        );
      }
      await route.fulfill({ response, json });
    });

    await openServerApp(page, serverToken);
    await page.getByRole('button', { name: new RegExp(tableSrcName) }).click();

    // Create the initial dine-in order on Table Src.
    const search = page.getByTestId('pos-product-grid').getByPlaceholder('Search menu');
    await search.fill('E2E Coffee');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Current ticket' }).click();
    await page.getByRole('button', { name: 'Send to kitchen' }).last().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();

    await pickTable(page, tableSrcName);
    // Open mobile ticket drawer: Move Table is hidden while tables.orders.move is not granted.
    await page.getByRole('button', { name: 'Current ticket' }).click();
    await expect(page.getByRole('button', { name: 'Move Table' })).toHaveCount(0);

    // Close drawer, grant tables.orders.move, mark the order as served, and tap Refresh:
    // served orders must remain loaded in currentOrder so Move Table is available.
    await page.keyboard.press('Escape');
    const srcOrdersLookup = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: tableSrc.id, type: 'dine_in', per_page: 5 },
    });
    const { orders: srcOrdersBeforeMove } = await srcOrdersLookup.json();
    expect(srcOrdersBeforeMove).toHaveLength(1);
    const markServedRes = await page.request.patch(
      `${E2E_BASE_URL}/api/orders/${srcOrdersBeforeMove[0].id}/status`,
      {
        headers,
        data: { status: 'served' },
      },
    );
    expect(markServedRes.ok()).toBeTruthy();

    grantMovePermission = true;
    const authMeRefresh = page.waitForResponse(
      (res) => res.url().includes('/api/auth/me') && res.ok(),
    );
    const servedOrderRefresh = page.waitForResponse(
      (res) =>
        res.url().includes('/api/orders') &&
        res.url().includes(`table_id=${tableSrc.id}`) &&
        res.url().includes('served') &&
        res.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await Promise.all([authMeRefresh, servedOrderRefresh]);

    // Add a second item whose append commits on the backend while its HTTP reply is lost (500).
    await search.fill('E2E Coffee');
    await search.press('Enter');

    const appendIdempotencyKeys: string[] = [];
    let simulateLostAppendReply = true;
    await page.route('**/api/orders/*/items', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      appendIdempotencyKeys.push(route.request().headers()['idempotency-key'] || '');
      if (simulateLostAppendReply) {
        simulateLostAppendReply = false;
        const committed = await route.fetch();
        expect(committed.ok()).toBeTruthy();
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary failure after append commit' }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Current ticket' }).click();
    const moveTableButton = page.getByRole('button', { name: 'Move Table' }).last();
    await expect(moveTableButton).toBeVisible();
    await page.getByRole('button', { name: 'Add to order' }).last().click();
    await expect(page.getByRole('button', { name: 'Add to order' }).last()).toBeEnabled();
    expect(appendIdempotencyKeys).toHaveLength(1);
    expect(appendIdempotencyKeys[0]).toContain(`server-app-${tableSrc.id}-`);

    let markMoveIntercepted: () => void = () => {};
    let releaseMoveOrder: () => void = () => {};
    const moveIntercepted = new Promise<void>((resolve) => {
      markMoveIntercepted = resolve;
    });
    const moveGate = new Promise<void>((resolve) => {
      releaseMoveOrder = resolve;
    });
    await page.route('**/api/tables/*/move-order', async (route) => {
      markMoveIntercepted();
      await moveGate;
      await route.continue();
    });

    // Tap Move Table inside the mobile ticket drawer: the drawer closes so MoveTableModal is uncovered and clickable.
    await moveTableButton.click();
    const modal = page.getByTestId('move-table-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: new RegExp(tableDstName) }).click();
    await modal.getByRole('button', { name: new RegExp(`Move to ${tableDstName}`) }).click();
    await moveIntercepted;

    // While the move request is in flight, both the header X close button and the footer Cancel button must be disabled.
    const cancelButtons = modal.getByRole('button', { name: 'Cancel' });
    await expect(cancelButtons.first()).toBeDisabled();
    await expect(cancelButtons.last()).toBeDisabled();

    releaseMoveOrder();
    await expect(modal).toBeHidden();
    await expect(page.locator('header')).toContainText(tableDstName);

    // Retry sending the pending draft on Table Dst: must reuse the original Idempotency-Key and not duplicate the item.
    await page.getByRole('button', { name: 'Current ticket' }).click();
    await page.getByRole('button', { name: 'Add to order' }).last().click();
    await expect(page.getByText('Order sent').first()).toBeVisible();
    expect(appendIdempotencyKeys).toHaveLength(2);
    expect(appendIdempotencyKeys[1]).toBe(appendIdempotencyKeys[0]);

    const dstOrdersRes = await page.request.get(`${E2E_BASE_URL}/api/orders`, {
      headers,
      params: { table_id: tableDst.id, type: 'dine_in', per_page: 5 },
    });
    const { orders: dstOrders } = await dstOrdersRes.json();
    expect(dstOrders).toHaveLength(1);
    const totalCoffeeQty = (dstOrders[0]?.items || [])
      .filter((item: { product_name: string }) => item.product_name === 'E2E Coffee')
      .reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);
    expect(totalCoffeeQty).toBe(2);

    // A late /api/auth/me reply finishing after logout must not restore the logged-out user.
    await page.keyboard.press('Escape');
    delayNextAuthMe = true;
    const delayedAuthMeResponse = page.waitForResponse((res) => res.url().includes('/api/auth/me'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await authMeIntercepted;
    await logoutServerApp(page);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    releaseAuthMe();
    await delayedAuthMeResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test('Server App locks locally on configured inactivity even if logout fails', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/settings/auto_lock_minutes', (route) =>
    route.fulfill({ json: { setting: { value: '1' } } }),
  );
  let logoutAttempts = 0;
  await page.route('**/api/auth/logout', (route) => {
    logoutAttempts += 1;
    return route.fulfill({ status: 503, json: { error: 'offline' } });
  });
  const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
  await openServerApp(page, serverToken);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  await page.clock.fastForward('00:59');
  await page.keyboard.press('Shift');
  await page.clock.fastForward('00:59');
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  await page.clock.fastForward('00:02');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  await expect.poll(() => logoutAttempts).toBe(1);
});
