import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('selected tables are deleted together and a table with an open order is reported', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const authHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const businessResponse = await page.request.get(`${BASE}/api/settings/business`, {
    headers: authHeaders,
  });
  expect(businessResponse.ok()).toBeTruthy();
  const originalBusiness = await businessResponse.json();

  const runId = Date.now();
  const names = [`E2E-DEL-A-${runId}`, `E2E-DEL-B-${runId}`, `E2E-DEL-BUSY-${runId}`];
  const ids: string[] = [];
  let orderId: number | undefined;

  try {
    const businessUpdate = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, billing_type: 'postpaid', tables_required: true },
    });
    expect(businessUpdate.ok()).toBeTruthy();

    for (const number of names) {
      const res = await page.request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number, capacity: 4 },
      });
      expect(res.ok()).toBeTruthy();
      ids.push((await res.json()).table.id);
    }
    const orderRes = await page.request.post(`${BASE}/api/orders`, {
      headers: authHeaders,
      data: {
        type: 'dine_in',
        table_id: ids[2],
        items: [{ product_id: 'e2e-product', quantity: 1 }],
      },
    });
    expect(orderRes.status()).toBe(201);
    orderId = (await orderRes.json()).order.id;

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/tables`);

    const deleteButton = page.getByTestId('bulk-delete-tables');
    await expect(deleteButton).toBeDisabled();
    await expect(deleteButton).toHaveText('Delete tables');

    for (const id of ids) await page.getByTestId(`select-table-${id}`).check();
    await expect(deleteButton).toBeEnabled();
    await expect(deleteButton).toHaveText('Delete tables (3)');

    await deleteButton.click();
    const dialog = page.getByTestId('bulk-delete-tables-dialog');
    await expect(dialog).toContainText('Delete 3 tables?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`table-card-${ids[0]}`)).toBeVisible();

    await deleteButton.click();
    await page.getByTestId('bulk-delete-tables-confirm').click();

    await expect(page.getByText('Deleted 2 tables')).toBeVisible();
    await expect(page.getByText(`${names[2]}: has an open order, not deleted`)).toBeVisible();
    await expect(page.getByTestId(`table-card-${ids[0]}`)).toHaveCount(0);
    await expect(page.getByTestId(`table-card-${ids[1]}`)).toHaveCount(0);
    await expect(page.getByTestId(`table-card-${ids[2]}`)).toBeVisible();
    await expect(page.getByTestId(`select-table-${ids[2]}`)).toBeChecked();
    await expect(deleteButton).toHaveText('Delete tables (1)');

    const list = await page.request.get(`${BASE}/api/tables`, {
      headers: authHeaders,
    });
    const remaining = ((await list.json()).tables as { id: string }[]).map((t) => t.id);
    expect(remaining).not.toContain(ids[0]);
    expect(remaining).not.toContain(ids[1]);
    expect(remaining).toContain(ids[2]);
  } finally {
    if (orderId) {
      await page.request
        .post(`${BASE}/api/orders/${orderId}/cancel`, { headers: authHeaders })
        .catch(() => {});
    }
    for (const id of ids) {
      await page.request
        .delete(`${BASE}/api/tables/${id}`, { headers: authHeaders })
        .catch(() => {});
    }
    await page.request
      .put(`${BASE}/api/settings/business`, { headers: authHeaders, data: originalBusiness })
      .catch(() => {});
  }
});
