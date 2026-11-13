import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';
import { detectKdsBoardChanges, kdsItemPlaces } from '../src/lib/kds-messages';
import type { KdsOrder } from '../src/hooks/useKdsConnection';

test('startup language sync does not turn existing KDS tables into move notices', () => {
  const order = {
    id: 1,
    order_number: 'ORD-1',
    table_id: 'table-1',
    table: { name: '1' },
    items: [{ id: 10, product_name: 'Soup' }],
  } as unknown as KdsOrder;
  const initial = kdsItemPlaces([order], () => 'Table 1');
  const localized = kdsItemPlaces([order], () => 'โต๊ะ 1');
  expect(detectKdsBoardChanges(initial, localized)).toEqual([]);
  const renamed = kdsItemPlaces([{ ...order, table: { name: 'A1' } }], () => 'โต๊ะ A1');
  expect(detectKdsBoardChanges(localized, renamed)).toEqual([]);
  const moved = kdsItemPlaces(
    [{ ...order, table_id: 'table-2', table: { name: '2' } }],
    () => 'โต๊ะ 2',
  );
  expect(detectKdsBoardChanges(localized, moved)).toEqual([
    { kind: 'move', key: 'move:1:โต๊ะ 2', from: 'โต๊ะ 1', to: 'โต๊ะ 2' },
  ]);
});

test('KDS language resync leaves existing tables quiet and still announces a real move', async ({
  page,
}) => {
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${token}` };
  const run = Math.random().toString(36).slice(2, 7);
  const tables: { id: string; number: string }[] = [];
  let orderId: number | undefined;
  let language = 'en';
  await page.route('**/api/kds/info', (route) =>
    route.fulfill({
      json: { language, country: 'TH', kds_default_view: 'kanban' },
    }),
  );
  await page.addInitScript(
    (accessToken: string) => localStorage.setItem('token', accessToken),
    token,
  );
  try {
    for (const number of [`Language A ${run}`, `Language B ${run}`]) {
      const response = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
        headers,
        data: { number, capacity: 2 },
      });
      expect(response.ok()).toBeTruthy();
      tables.push((await response.json()).table);
    }
    const created = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tables[0].id,
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(created.ok()).toBeTruthy();
    orderId = (await created.json()).order.id;
    await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
    await expect(page.getByText(`Table ${tables[0].number}`, { exact: true })).toBeVisible();
    language = 'th';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'จอแสดงผลในครัว' })).toBeVisible();
    await expect(page.getByText(`โต๊ะ ${tables[0].number}`, { exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="kds-message"][data-kind="move"]')).toHaveCount(0);
    const moved = await page.request.post(`${E2E_BASE_URL}/api/tables/${tables[0].id}/move-order`, {
      headers,
      data: { target_table_id: tables[1].id, order_id: orderId },
    });
    expect(moved.ok(), await moved.text()).toBeTruthy();
    const notice = page.locator('[data-testid="kds-message"][data-kind="move"]');
    await expect(notice).toContainText(tables[0].number);
    await expect(notice).toContainText(tables[1].number);
  } finally {
    if (orderId) {
      const cancelled = await page.request.patch(`${E2E_BASE_URL}/api/orders/${orderId}/status`, {
        headers,
        data: { status: 'cancelled' },
      });
      expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
    }
    for (const table of tables) {
      const removed = await page.request.post(`${E2E_BASE_URL}/api/tables/${table.id}/deactivate`, {
        headers,
      });
      expect(removed.ok(), await removed.text()).toBeTruthy();
    }
  }
});

test('the KDS message bar lists table moves, merges, take-away changes and emergency calls until acknowledged', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const makeTable = async (label: string) => {
    const res = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
      headers,
      data: { number: label, capacity: 2 },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).table.id as string;
  };
  const makeOrder = async (tableId: string, note: string) => {
    const res = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tableId,
        items: [
          { product_id: 'e2e-product', quantity: 1, special_instructions: note },
          { product_id: 'e2e-product', quantity: 1, special_instructions: `${note} extra` },
        ],
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).order as { id: number; items: { id: number }[] };
  };
  const moveFrom = `MvA ${run}`;
  const moveTo = `MvB ${run}`;
  const mergeFrom = `MgA ${run}`;
  const mergeInto = `MgB ${run}`;
  const moveFromId = await makeTable(moveFrom);
  const moveToId = await makeTable(moveTo);
  const mergeFromId = await makeTable(mergeFrom);
  const mergeIntoId = await makeTable(mergeInto);
  const moving = await makeOrder(moveFromId, `move ${run}`);
  const merging = await makeOrder(mergeFromId, `merge ${run}`);
  await makeOrder(mergeIntoId, `stay ${run}`);

  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  const bar = page.getByTestId('kds-message-bar');
  await expect(bar).toBeVisible();
  // The bar sits at the bottom edge of the screen, below the board.
  const barBox = (await bar.boundingBox())!;
  expect(900 - (barBox.y + barBox.height)).toBeLessThanOrEqual(24);
  // The Kanban columns reach down to the top of the bar.
  const columnBox = (await page.getByTestId('kds-column-pending').boundingBox())!;
  expect(barBox.y - (columnBox.y + columnBox.height)).toBeLessThanOrEqual(16);
  for (const note of ['move', 'merge', 'stay']) {
    await expect(page.getByText(`${note} ${run}`).first()).toBeVisible({ timeout: 15000 });
  }
  const notices = bar.getByTestId('kds-message');
  const startCount = await notices.count();

  // Moving an order to another table.
  const moved = await page.request.post(`${E2E_BASE_URL}/api/tables/${moveFromId}/move-order`, {
    headers,
    data: { target_table_id: moveToId, order_id: moving.id },
  });
  expect(moved.ok(), await moved.text()).toBeTruthy();
  const moveNotice = bar.locator('[data-testid="kds-message"][data-kind="move"]', {
    hasText: moveFrom,
  });
  await expect(moveNotice).toContainText(`Moved Table ${moveFrom} to Table ${moveTo}`, {
    timeout: 15000,
  });
  const movedBadge = page.getByText(`Moved from table ${moveFrom}`, { exact: true });
  await expect(movedBadge).toHaveCount(1);
  await expect(
    movedBadge.locator('..').getByText(`Table ${moveTo}`, { exact: true }),
  ).toBeVisible();

  // Merging one table's order into another table's order.
  const merged = await page.request.post(`${E2E_BASE_URL}/api/orders/${merging.id}/merge-table`, {
    headers,
    data: { target_table_id: mergeIntoId },
  });
  expect(merged.ok(), await merged.text()).toBeTruthy();
  const mergeNotice = bar.locator('[data-testid="kds-message"][data-kind="merge"]', {
    hasText: mergeFrom,
  });
  await expect(mergeNotice).toContainText(`Merged Table ${mergeFrom} into Table ${mergeInto}`, {
    timeout: 15000,
  });

  // Switching an item to take-away.
  const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
  const takeaway = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${moving.id}/items/${moving.items[0].id}/takeaway`,
    { headers: { Authorization: `Bearer ${serverToken}` } },
  );
  expect(takeaway.status()).toBe(200);
  const takeawayNotice = bar.locator('[data-testid="kds-message"][data-kind="takeaway"]', {
    hasText: moveTo,
  });
  await expect(takeawayNotice).toContainText('changed to take-away', { timeout: 15000 });

  // An emergency call reaching the Server App's alert endpoint.
  const alert = await page.request.post(`${E2E_SERVER_APP_BASE_URL}/api/kds-alerts`, {
    headers: { Authorization: `Bearer ${managerToken}` },
    data: { message: `Spill ${run}`, table: moveTo },
  });
  expect(alert.ok(), await alert.text()).toBeTruthy();
  const emergencyNotice = bar.locator('[data-testid="kds-message"][data-kind="emergency"]', {
    hasText: `Spill ${run}`,
  });
  await expect(emergencyNotice).toContainText(`Emergency · Table ${moveTo} · Spill ${run}`, {
    timeout: 15000,
  });
  await expect(notices).toHaveCount(startCount + 4);

  // Acknowledged notices stay gone after a reload; the rest stay, and the emergency does not come back.
  await moveNotice.getByTestId('kds-message-dismiss').click();
  await emergencyNotice.getByTestId('kds-message-dismiss').click();
  await expect(notices).toHaveCount(startCount + 2);
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(mergeNotice).toBeVisible();
  await expect(takeawayNotice).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(moveNotice).toHaveCount(0);
  await expect(emergencyNotice).toHaveCount(0);

  // Cancelling the take-away item turns its notice into a cancelled one in the same place.
  const cancel = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${moving.id}/items/${moving.items[0].id}/cancel`,
    { headers: { Authorization: `Bearer ${serverToken}` }, data: {} },
  );
  expect(cancel.status(), await cancel.text()).toBe(200);
  const cancelledNotice = bar.locator('[data-testid="kds-message"][data-kind="cancelled"]', {
    hasText: moveTo,
  });
  await expect(cancelledNotice).toContainText(`Table ${moveTo}:`, { timeout: 15000 });
  await expect(cancelledNotice).toContainText('cancelled');
  await expect(takeawayNotice).toHaveCount(0);
  await expect(notices).toHaveCount(startCount + 2);

  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**');
  await page.goto(`${E2E_BASE_URL}/orders`);
  const orderList = page.getByTestId('orders-master-pane');
  const posMoveBadge = orderList.getByText(`Moved from table ${moveFrom}`, { exact: true });
  await expect(posMoveBadge).toBeVisible();
  await expect(
    orderList.getByText(`Merged from table ${mergeFrom}`, { exact: true }),
  ).toBeVisible();
  await posMoveBadge.click();
  await expect(
    page
      .getByTestId('orders-detail-panel')
      .getByText(`Moved from table ${moveFrom}`, { exact: true }),
  ).toBeVisible();
});

test('the message box switch in display settings hides the message bar, leaving only the bell when it is shown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    page.getByTestId('kds-login-form').or(page.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await page.getByTestId('kds-login-form').isVisible()) {
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
  }
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByTestId('kds-message-box')).toBeVisible();

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  const boxSwitch = dialog.getByTestId('kds-display-switch-showMessages');
  await expect(boxSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(boxSwitch).toHaveAccessibleName('Message box');
  await boxSwitch.click();
  await expect(boxSwitch).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('kds-message-bar')).toHaveCount(0);

  // With the bell shown, the bar holds only the bell at its right end.
  await page.getByTestId('kds-settings-button').click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('kds-settings-tab-sound').click();
  await dialog.getByTestId('kds-sound-switch-showBell').click();
  await page.keyboard.press('Escape');
  const bar = page.getByTestId('kds-message-bar');
  await expect(bar.getByTestId('kds-bell-button')).toBeVisible();
  await expect(bar.getByTestId('kds-message-box')).toHaveCount(0);

  // The choice is kept after a reload.
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(bar.getByTestId('kds-bell-button')).toBeVisible();
  await expect(page.getByTestId('kds-message-box')).toHaveCount(0);
});
