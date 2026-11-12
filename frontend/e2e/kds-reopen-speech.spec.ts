import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

type SpeechLog = { __spoken: string[] };

async function recordSpeech(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as SpeechLog & Record<string, unknown>;
    w.__spoken = [];
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
          connect: (n: unknown) => n,
          start() {},
          stop() {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: (n: unknown) => n };
      }
      decodeAudioData() {
        return Promise.resolve({ duration: 0 });
      }
      createBufferSource() {
        return { buffer: null, onended: null, connect: (n: unknown) => n, start() {} };
      }
    }
    class FakeUtterance {
      lang = '';
      rate = 1;
      volume = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    }
    w.AudioContext = FakeAudioContext;
    w.SpeechSynthesisUtterance = FakeUtterance;
    const voices = [
      { name: 'Microsoft Fake Online (Natural) - English', lang: 'en-US', localService: false },
    ];
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: (utterance: FakeUtterance & { onend?: () => void }) => {
          if (utterance.volume > 0) w.__spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 0);
        },
      },
    });
  });
}

const spokenAbout = async (page: Page, text: string) =>
  (await page.evaluate(() => (window as unknown as SpeechLog).__spoken)).filter((line) =>
    line.includes(text),
  );

test('a reopened KDS does not read out items it already announced, but still reads new ones', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const headers = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const run = Math.random().toString(36).slice(2, 7);
  const category = await page.request.post(`${E2E_BASE_URL}/api/categories`, {
    headers,
    data: { name: `Reopen ${run}` },
  });
  expect(category.status()).toBe(201);
  const productName = `Curry ${run}`;
  const product = await page.request.post(`${E2E_BASE_URL}/api/products`, {
    headers,
    data: {
      name: productName,
      category_id: (await category.json()).category.id,
      price: 40,
      tax_category_id: null,
      tax_behavior: 'exempt',
    },
  });
  expect(product.status()).toBe(201);
  const productId = (await product.json()).product.id as string;
  const placeOrder = async (quantity: number) => {
    const order = await page.request.post(`${E2E_BASE_URL}/api/orders`, {
      headers,
      data: { type: 'takeaway', items: [{ product_id: productId, quantity }] },
    });
    expect(order.status()).toBe(201);
    return (await order.json()).order as { order_number: string };
  };

  await recordSpeech(page);
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
  await page.waitForTimeout(1000);

  const first = await placeOrder(3);
  await expect
    .poll(() => spokenAbout(page, productName), { timeout: 15000 })
    .toEqual([`3 ${productName}`]);

  // Reloading the display shows the order again without reading it out.
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByText(`#${first.order_number}`).first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(2500);
  expect(await spokenAbout(page, productName)).toEqual([]);

  // So does a second display opened on the same device.
  const second = await context.newPage();
  await recordSpeech(second);
  await second.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(second.getByTestId('kds-workspace')).toBeVisible();
  await expect(second.getByText(`#${first.order_number}`).first()).toBeVisible({ timeout: 15000 });
  await second.waitForTimeout(2500);
  expect(await spokenAbout(second, productName)).toEqual([]);
  await second.close();

  // An order that arrives after the reload is still read out.
  await placeOrder(5);
  await expect
    .poll(() => spokenAbout(page, productName), { timeout: 15000 })
    .toEqual([`5 ${productName}`]);

  // After a dropped connection only the order that came in meanwhile is read out.
  await context.setOffline(true);
  await page.waitForTimeout(3000);
  await placeOrder(7);
  await context.setOffline(false);
  await expect
    .poll(() => spokenAbout(page, productName), { timeout: 30000 })
    .toEqual([`5 ${productName}`, `7 ${productName}`]);
  await page.waitForTimeout(2500);
  expect(await spokenAbout(page, productName)).toHaveLength(2);
});
