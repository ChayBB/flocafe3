import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL as KDS } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test.use({ hasTouch: true, viewport: { width: 1280, height: 800 } });

test('tablet columns scroll by swiping with no paging buttons, and toggle full screen', async ({
  page,
  context,
}) => {
  const headers = { Authorization: `Bearer ${getE2eToken()}` };
  for (let index = 0; index < 18; index++) {
    const response = await page.request.post(`${BASE}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto(`${KDS}/kds-standalone`);
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tabs', exact: true })).toHaveCount(0);
  const column = page.getByTestId('kds-column-pending');
  const area = column.getByTestId('kds-scroll-area');
  await expect
    .poll(() => area.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect(page.getByTestId('kds-scroll-controls')).toHaveCount(0);
  const box = (await area.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height - 30, 250);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - step * 15 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => area.evaluate((element) => element.scrollTop)).toBeGreaterThan(30);
  await page.getByTestId('kds-fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByTestId('kds-fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});
