import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { openServerAppTables } from './helpers/server-app';
import { getE2eToken } from './helpers/test-auth';

const TOKEN_KEY = 'flocafe:server-app-token';

test('several dishes are confirmed served at once from a ticked list, leaving out any unticked', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const label = `Many ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: label, capacity: 4 },
  });
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [1, 2, 3, 4].map((n) => ({
        product_id: 'e2e-product',
        quantity: 1,
        special_instructions: `${run}-${n}`,
      })),
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { items: { id: number }[] };
  const moveTo = async (itemId: number, statuses: string[]) => {
    for (const status of statuses) {
      const res = await page.request.patch(`${E2E_BASE_URL}/api/order-items/${itemId}/status`, {
        headers,
        data: { status },
      });
      expect(res.ok()).toBeTruthy();
    }
  };
  await moveTo(created.items[0].id, ['preparing', 'ready']);
  await moveTo(created.items[1].id, ['preparing', 'ready']);
  await moveTo(created.items[2].id, ['preparing', 'ready', 'served']);
  await moveTo(created.items[3].id, ['preparing']);

  await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
  await page.evaluate(
    ([key, token]) => {
      localStorage.setItem(key, token);
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: 'en' };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    },
    [TOKEN_KEY, getE2eToken('e2e-server', 'server@flo.local', 'server')],
  );
  await page.reload();
  await openServerAppTables(page);
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.getByTestId('server-app-ordered-items-button').click();
  await expect(page.getByTestId('server-app-ordered-item')).toHaveCount(4);

  // Every dish not yet confirmed counts, the one still cooking included: staff confirm what reaches the table.
  const confirmMany = page.getByTestId('server-app-confirm-served-many');
  await expect(confirmMany).toHaveText('Confirm 4 dishes served');
  await confirmMany.click();
  const dialog = page.getByTestId('server-app-confirm-served-dialog');
  const rows = dialog.getByTestId('server-app-confirm-served-row');
  await expect(rows).toHaveCount(4);
  for (const index of [0, 1, 2, 3])
    await expect(rows.nth(index).getByRole('checkbox')).toBeChecked();
  await rows.nth(0).getByRole('checkbox').uncheck();
  const submit = dialog.getByTestId('server-app-confirm-served-submit');
  await expect(submit).toHaveText('Confirm (3)');
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('3 dishes confirmed served').first()).toBeVisible();

  // One dish is left to confirm, and the footer button still offers it.
  const items = page.getByTestId('server-app-ordered-item');
  await expect(items.getByTestId('server-app-served-confirmed-tag')).toHaveCount(3);
  await expect(items.nth(0).getByTestId('server-app-served-confirmed-tag')).toHaveCount(0);
  await expect(confirmMany).toHaveText('Confirm 1 dish served');

  // The last dish is confirmed with one tap, without the checklist.
  await confirmMany.click();
  await expect(dialog).toHaveCount(0);
  await expect(items.getByTestId('server-app-served-confirmed-tag')).toHaveCount(4);
  await expect(confirmMany).toHaveCount(0);
});
