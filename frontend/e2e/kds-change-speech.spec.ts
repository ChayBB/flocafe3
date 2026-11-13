import { test, expect } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

test('the KDS reads out the table and dish of an item changed to take-away or cancelled', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const asServer = {
    Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const tableName = `Say ${run}`;
  const table = await page.request.post(`${E2E_BASE_URL}/api/tables`, {
    headers,
    data: { number: tableName, capacity: 2 },
  });
  const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
    headers,
    data: {
      type: 'dine_in',
      table_id: (await table.json()).table.id,
      items: [1, 2].map((n) => ({
        product_id: 'e2e-product',
        quantity: 1,
        special_instructions: `${run}-${n}`,
      })),
    },
  });
  expect(order.status()).toBe(201);
  const created = (await order.json()).order as { id: number; items: { id: number }[] };

  await page.addInitScript(() => {
    const w = window as unknown as { __spoken: string[] } & Record<string, unknown>;
    w.__spoken = [];
    class FakeUtterance {
      lang = '';
      rate = 1;
      volume = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    }
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = 'running';
      onstatechange: (() => void) | null = null;
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0 },
          connect: (node: unknown) => node,
          start() {},
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (node: unknown) => node };
      }
    }
    w.AudioContext = FakeAudioContext;
    w.SpeechSynthesisUtterance = FakeUtterance;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [{ name: 'Fake Local English', lang: 'en-US', localService: true }],
        speak: (utterance: FakeUtterance & { onend?: () => void }) => {
          w.__spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 0);
        },
        cancel: () => {},
      },
    });
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
  const row = (n: number) => page.getByTestId('kds-item-row').filter({ hasText: `${run}-${n}` });
  await expect(row(1)).toBeVisible({ timeout: 20000 });
  await expect(row(2)).toBeVisible();
  await page.clock.install();

  const takeaway = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${created.id}/items/${created.items[0].id}/takeaway`,
    { headers: asServer },
  );
  expect(takeaway.status()).toBe(200);
  const cancel = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${created.id}/items/${created.items[1].id}/cancel`,
    { headers: asServer, data: {} },
  );
  expect(cancel.status()).toBe(200);
  const preparing = page.getByTestId('kds-column-preparing');
  const served = page.getByTestId('kds-column-served');
  await expect(preparing.getByTestId('kds-item-row').filter({ hasText: `${run}-2` })).toContainText(
    'Cancelled',
  );
  await expect(served.getByTestId('kds-item-row').filter({ hasText: `${run}-2` })).toHaveCount(0);

  const spoken = () =>
    page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join(' | '));
  await expect
    .poll(spoken, { timeout: 15000 })
    .toContain(`Table ${tableName}, E2E Coffee, changed to take-away`);
  await expect
    .poll(spoken, { timeout: 15000 })
    .toContain(`Table ${tableName}, E2E Coffee, cancelled`);

  const lastCancel = await page.request.patch(
    `${E2E_SERVER_APP_BASE_URL}/api/orders/${created.id}/items/${created.items[0].id}/cancel`,
    { headers: asServer, data: {} },
  );
  expect(lastCancel.status()).toBe(200);
  await expect(preparing.getByTestId('kds-item-row').filter({ hasText: `${run}-1` })).toContainText(
    'Cancelled',
  );
  await page.clock.fastForward(20_000);
  await expect(preparing.getByTestId('kds-item-row').filter({ hasText: `${run}-2` })).toContainText(
    'Cancelled',
  );
  await page.clock.fastForward(11_000);
  await expect(preparing.getByTestId('kds-item-row').filter({ hasText: `${run}-2` })).toHaveCount(
    0,
  );
  await expect(served.getByTestId('kds-item-row').filter({ hasText: `${run}-2` })).toContainText(
    'Cancelled',
  );
});
