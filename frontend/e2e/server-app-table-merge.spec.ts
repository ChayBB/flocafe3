import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('the ordered-items menu merges a table into another table by its typed number', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const managerToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${managerToken}` };
  const run = Math.random().toString(36).slice(2, 7);
  const makeTable = async (label: string) =>
    (
      await (
        await page.request.post(`${E2E_BASE_URL}/api/tables`, {
          headers,
          data: { number: label, capacity: 2 },
        })
      ).json()
    ).table.id as string;
  const makeOrder = async (tableId: string, quantity: number) => {
    const res = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: {
        type: 'dine_in',
        table_id: tableId,
        items: [{ product_id: 'e2e-product', quantity }],
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).order as { id: number; order_number: string };
  };
  const from = `MA ${run}`;
  const into = `MB ${run}`;
  const free = `MC ${run}`;
  const fromId = await makeTable(from);
  const intoId = await makeTable(into);
  await makeTable(free);
  const source = await makeOrder(fromId, 2);
  const target = await makeOrder(intoId, 1);

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
  await page.getByRole('button', { name: new RegExp(from) }).click();
  await page.getByTestId('server-app-ordered-items-button').click();

  const screen = page.getByTestId('server-app-ordered-items');
  const lastItem = (await screen.getByTestId('server-app-ordered-item').last().boundingBox())!;
  const actions = (await screen.getByTestId('server-app-ordered-actions').boundingBox())!;
  expect(Math.round(actions.y - (lastItem.y + lastItem.height))).toBe(70);
  await expect(screen.getByTestId('server-app-ordered-actions')).toHaveCSS(
    'border-top-width',
    '1px',
  );
  const summary = (await screen.getByTestId('server-app-ordered-summary').boundingBox())!;
  expect(summary.y).toBeGreaterThan(actions.y);
  expect(summary.y - actions.y).toBeLessThan(20);
  await expect(screen.getByTestId('server-app-ordered-add')).toBeVisible();
  await expect(screen.getByTestId('server-app-ordered-exit')).toBeVisible();
  await screen.getByTestId('server-app-ordered-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Move table' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Merge tables' }).click();

  const dialog = page.getByTestId('server-app-table-transfer');
  await expect(dialog).toContainText(`Merge the items of table ${from} into table:`);
  const input = dialog.getByTestId('server-app-table-transfer-input');
  const confirm = dialog.getByTestId('server-app-table-transfer-confirm');
  await input.fill(free);
  await confirm.click();
  await expect(dialog.getByTestId('server-app-table-transfer-error')).toHaveText(
    `Table ${free} has no order; use Move table instead`,
  );
  await input.fill(`nope ${run}`);
  await confirm.click();
  await expect(dialog.getByTestId('server-app-table-transfer-error')).toHaveText(
    `No table nope ${run}, or it is switched off in table settings`,
  );
  await input.fill(into.toLowerCase());
  await confirm.click();

  await expect(page.getByText(`Merged into table ${into}`).first()).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(screen).toContainText(`Table ${into}`);
  await expect(screen).toContainText(target.order_number);
  await expect(screen.getByTestId('server-app-ordered-item')).toHaveCount(2);

  const merged = await (
    await page.request.get(`${E2E_BASE_URL}/api/orders/${target.id}`, { headers })
  ).json();
  expect(merged.order.items.map((item: { quantity: number }) => item.quantity).sort()).toEqual([
    1, 2,
  ]);
  const closed = await (
    await page.request.get(`${E2E_BASE_URL}/api/orders/${source.id}`, { headers })
  ).json();
  expect(closed.order.status).toBe('cancelled');
});
