import { test, expect } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';

test('a ticket kept while the printer is out of paper pops up for a manual reprint once paper is back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = Math.random().toString(36).slice(2, 7);
  const ref = `21:Kitchen-${run}`;
  const alerts: Record<string, unknown>[] = [
    {
      id: `kot-paper-${run}`,
      kind: 'kot_unprinted',
      message: `ORD-P-${run}`,
      table: `P${run}`,
      sent_by: null,
      ref,
      reason: 'paper_out',
      created_at: new Date().toISOString(),
    },
  ];
  await page.route('**/api/kds/orders**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, alerts: [...(body.alerts ?? []), ...alerts] },
    });
  });
  // No socket: the display polls the REST endpoint, which carries the alerts this test adds.
  await page.routeWebSocket(/\/kds(\?.*)?$/, (ws) => ws.close());

  let reprints = 0;
  await page.route('**/api/kds/unprinted-kots/**', async (route) => {
    if (route.request().method() === 'POST') reprints += 1;
    await route.fulfill({ status: 200, json: { success: true } });
  });

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

  const notice = page
    .locator('[data-testid="kds-message"][data-kind="kot_unprinted"]')
    .filter({ hasText: `Table P${run}` });
  await expect(notice).toContainText(`Print failed · Table P${run}`, { timeout: 20000 });

  // While the paper is out the dialog says why and that the ticket is kept; staff close it.
  await notice.click();
  const dialog = page.getByTestId('kds-kot-dialog');
  await expect(dialog.getByTestId('kds-kot-reason')).toContainText('out of paper');
  await expect(dialog.getByTestId('kds-kot-reason')).toContainText('kept');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(reprints).toBe(0);

  // Paper goes in; the backend notices and the dialog opens on its own, waiting for a person.
  alerts.push({
    id: `kot-ready-${run}`,
    kind: 'kot_ready',
    message: `ORD-P-${run}`,
    table: `P${run}`,
    sent_by: null,
    ref,
    reason: 'paper_out',
    created_at: new Date().toISOString(),
  });
  await expect(dialog).toBeVisible({ timeout: 20000 });
  await expect(dialog).toContainText(`Print failed · Table P${run}`);
  await expect(dialog.getByTestId('kds-kot-ready')).toContainText('ready again');
  await expect(notice).toHaveCount(1);
  expect(reprints).toBe(0);

  await dialog.getByTestId('kds-kot-reprint').click();
  await expect(dialog).toBeHidden();
  await expect(notice).toHaveCount(0);
  expect(reprints).toBe(1);

  // The ready alert stays in the feed for a while; it must not open the dialog again.
  await page.waitForTimeout(6000);
  await expect(dialog).toBeHidden();
  expect(reprints).toBe(1);
});
