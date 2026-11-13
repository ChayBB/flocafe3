import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

async function seedOrder(
  page: Page,
  headers: Record<string, string>,
  label: string,
  statuses: string[],
) {
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: label, capacity: 4 },
  });
  const tableId = (await table.json()).table.id;
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: tableId,
      items: statuses.map((_, index) => ({
        product_id: 'e2e-product',
        quantity: 1,
        special_instructions: `${label}-${index + 1}`,
      })),
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order;
  for (const [index, status] of statuses.entries()) {
    if (status === 'pending') continue;
    const res = await page.request.patch(
      `${E2E_BASE_URL}/api/order-items/${created.items[index].id}/status`,
      {
        headers,
        data: { status },
      },
    );
    expect(res.ok()).toBeTruthy();
  }
  return {
    tableId,
    order: created as { id: number; order_number: string; items: { id: number }[] },
  };
}

test('the item menu offers takeaway until served and cancel only while waiting; the KDS flags both with a sound', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const serverToken = getE2eToken('e2e-server', 'server@flo.local', 'server');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const label = `Change ${run}`;
  const { order } = await seedOrder(page, headers, label, [
    'pending',
    'preparing',
    'served',
    'pending',
    'pending',
  ]);

  // --- Server App: the menu after each status follows the rules.
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, managerToken],
  );
  await page.reload();
  await openServerAppTables(page);
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.getByTestId('server-app-ordered-items-button').click();
  const rows = page.getByTestId('server-app-ordered-item');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator('img')).toHaveCount(0);

  const menuOf = (index: number) => rows.nth(index).getByTestId('server-app-item-menu');
  // Waiting: takeaway and cancel.
  await menuOf(0).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Change to takeaway', 'Cancel item']);
  await menuOf(0).click();
  // In progress: takeaway only.
  await menuOf(1).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Change to takeaway']);
  await page.getByRole('menuitem', { name: 'Change to takeaway' }).click();
  await expect(page.getByText('Changed to takeaway').first()).toBeVisible();
  await expect(rows.nth(1).getByTestId('server-app-takeaway-tag')).toHaveText('Takeaway');
  // Served: only confirming it reached the table.
  await menuOf(2).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Confirm served']);
  await page.getByRole('menuitem', { name: 'Confirm served' }).click();
  await expect(page.getByText('Serving confirmed').first()).toBeVisible();
  await expect(rows.nth(2).getByTestId('server-app-served-confirmed-tag')).toHaveText(
    'At the table',
  );
  await expect(menuOf(2)).toBeDisabled();
  // Cancel the waiting one, after confirming.
  await menuOf(0).click();
  await page.getByRole('menuitem', { name: 'Cancel item' }).click();
  await page.getByRole('button', { name: 'Cancel item' }).last().click();
  await expect(page.getByText('Item cancelled').first()).toBeVisible();
  await expect(rows.nth(0).getByTestId('server-app-item-status')).toHaveText('Cancelled');

  // --- KDS: both changes are flagged in orange; a new change sounds the alert.
  const kds = await context.newPage();
  // Wide enough that a menu line holds its name and the staff note side by side.
  await kds.setViewportSize({ width: 1920, height: 1000 });
  await kds.addInitScript(() => {
    const w = window as unknown as { __beeps: number; AudioContext: unknown };
    w.__beeps = 0;
    // Like a real browser: suspended until the page is tapped.
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = 'suspended';
      onstatechange: (() => void) | null = null;
      resume() {
        this.state = 'running';
        this.onstatechange?.();
        return Promise.resolve();
      }
      createOscillator() {
        // The quiet sine hum that wakes a speaker is not an alert beep.
        return {
          type: '',
          frequency: { value: 0 },
          connect: (node: unknown) => node,
          start(this: { type: string }) {
            if (this.type !== 'sine') w.__beeps += 1;
          },
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (node: unknown) => node };
      }
      close() {
        return Promise.resolve();
      }
    }
    w.AudioContext = FakeAudioContext;
  });
  await kds.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(
    kds.getByTestId('kds-login-form').or(kds.getByTestId('kds-workspace')),
  ).toBeVisible();
  if (await kds.getByTestId('kds-login-form').isVisible()) {
    await kds.getByTestId('kds-login-email').fill('manager@flo.local');
    await kds.getByTestId('kds-login-password').fill('E2ePass123!');
    await kds.getByTestId('kds-login-submit').click();
  }
  // Notes are unique to this run, so earlier runs' orders on the board never match.
  const card = (line: number) =>
    kds.getByTestId('kds-item-row').filter({ hasText: `${label}-${line}"` });
  await expect(card(1)).toContainText('Cancelled');
  await expect(card(1)).toHaveClass(/bg-\(--kds-alert-bg\)/);
  await expect(card(1).getByTestId('kds-status-toggle')).toHaveCount(0);
  await expect(card(2)).toContainText('Changed to takeaway');
  // A confirmed line turns green and shows, beside the menu name, when and by whom.
  const confirmed = card(3).getByTestId('kds-served-confirmed');
  await expect(confirmed).toHaveText(/^\d{2}:\d{2} · .+$/);
  const confirmedBox = (await confirmed.boundingBox())!;
  const nameBox = (await card(3).getByText('E2E Coffee').first().boundingBox())!;
  expect(
    Math.abs(confirmedBox.y + confirmedBox.height / 2 - (nameBox.y + nameBox.height / 2)),
  ).toBeLessThan(12);
  await expect(card(3)).not.toHaveClass(/border-s-4/);
  await expect(card(3)).toHaveAttribute('data-served-confirmed', 'true');
  await expect(card(3)).toHaveClass(/bg-\(--kds-confirmed-bg\)/);
  await expect(card(2).getByTestId('kds-served-confirmed')).toHaveCount(0);
  const takeawayPill = card(2).getByTestId('kds-service-notice');
  await expect(takeawayPill).toHaveText('Changed to takeaway');
  await expect
    .poll(() => kds.evaluate(() => (window as unknown as { __beeps: number }).__beeps))
    .toBe(0);

  // A fresh page has not been tapped: sound stays off and the display flashes instead.
  await kds.reload();
  // The board has the item before it changes; an item first seen already changed does not alert.
  await expect(card(4)).toBeVisible();
  await expect(card(4).getByTestId('kds-service-notice')).toHaveCount(0);
  const asServer = { Authorization: `Bearer ${serverToken}` };
  const takeaway = await kds.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${order.id}/items/${order.items[3].id}/takeaway`,
    { headers: asServer },
  );
  expect(takeaway.status()).toBe(200);
  await expect(card(4)).toContainText('Changed to takeaway', { timeout: 15000 });
  await expect
    .poll(() =>
      kds.evaluate(
        () => document.querySelector('[data-testid="kds-change-flash"]')!.getAnimations().length,
      ),
    )
    .toBeGreaterThan(0);
  expect(await kds.evaluate(() => (window as unknown as { __beeps: number }).__beeps)).toBe(0);

  // Any key press or tap on the display turns sound on; the next change beeps.
  await kds.keyboard.press('Shift');
  const cancel = await kds.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${order.id}/items/${order.items[4].id}/cancel`,
    { headers: asServer, data: {} },
  );
  expect(cancel.status()).toBe(200);
  await expect(card(5)).toContainText('Cancelled', { timeout: 15000 });
  await expect
    .poll(() => kds.evaluate(() => (window as unknown as { __beeps: number }).__beeps))
    .toBe(3);
});

test('the item menu on the last ticket row opens fully in view, above the ticket footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const label = `Footer ${Math.random().toString(36).slice(2, 7)}`;
  const { tableId } = await seedOrder(page, headers, label, Array(12).fill('pending'));

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, managerToken],
  );
  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone?table=${tableId}`);
  const rows = page.getByTestId('server-app-ticket-item');
  await expect(rows).toHaveCount(12);
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await last.getByTestId('server-app-item-menu').click();
  const items = page.getByRole('menuitem');
  await expect(items).toHaveText(['Change to takeaway', 'Cancel item']);
  // Each choice is the topmost element at its centre, so nothing covers it.
  for (const item of await items.all()) {
    const box = (await item.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    const onTop = await item.evaluate(
      (element, [x, y]) => element.contains(document.elementFromPoint(x, y)),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(onTop).toBe(true);
  }
  await page.getByRole('menuitem', { name: 'Change to takeaway' }).click();
  await expect(last.getByTestId('server-app-takeaway-tag')).toHaveText('Takeaway');
});
