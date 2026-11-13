import { test, expect } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';
import { acknowledgeExistingKdsAlerts } from './helpers/kitchen-fixture';

test('a kitchen ticket that did not print shows silently as a pale chip that prints it again or drops it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await acknowledgeExistingKdsAlerts(page);
  const run = Math.random().toString(36).slice(2, 7);
  await page.addInitScript(() => {
    const w = window as unknown as { __spoken: string[]; __tones: number } & Record<
      string,
      unknown
    >;
    w.__spoken = [];
    w.__tones = 0;
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
          start() {
            w.__tones += 1;
          },
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
      },
    });
  });
  const alerts = [
    {
      id: `kot-table-${run}`,
      kind: 'kot_unprinted',
      message: `ORD-T-${run}`,
      table: `T${run}`,
      sent_by: null,
      ref: `11:Kitchen-${run}`,
      created_at: new Date().toISOString(),
    },
    {
      id: `kot-takeaway-${run}`,
      kind: 'kot_unprinted',
      message: `ORD-W-${run}`,
      table: null,
      sent_by: null,
      ref: `12:Kitchen-${run}`,
      created_at: new Date().toISOString(),
    },
  ];
  // The display gets its alerts with the orders, over the socket or the first REST load.
  const withAlerts = (body: { alerts?: unknown[] }) => ({
    ...body,
    alerts: [...(body.alerts ?? []), ...alerts],
  });
  await page.route('**/api/kds/orders**', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withAlerts(await response.json()) });
  });
  await page.routeWebSocket(/\/kds(\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        const data = JSON.parse(String(message));
        if (data.type === 'initial_data' || data.type === 'orders') {
          ws.send(JSON.stringify(withAlerts(data)));
          return;
        }
      } catch {}
      ws.send(message);
    });
  });

  let reprintAttempts = 0;
  await page.route('**/api/kds/unprinted-kots/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      reprintAttempts += 1;
      await route.fulfill(
        reprintAttempts === 1
          ? { status: 502, json: { error: 'printer offline' } }
          : { status: 200, json: { success: true } },
      );
      return;
    }
    await route.fulfill({ status: 200, json: { success: true } });
  });
  const dropped: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().includes('/api/kds/unprinted-kots/'))
      dropped.push(decodeURIComponent(request.url().split('/').pop() || ''));
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

  const notices = page.locator('[data-testid="kds-message"][data-kind="kot_unprinted"]');
  const tableNotice = notices.filter({ hasText: `Table T${run}` });
  const takeawayNotice = notices.filter({ hasText: `ORD-W-${run}` });
  await expect(tableNotice).toContainText(`Print failed · Table T${run}`, { timeout: 20000 });
  await expect(tableNotice).toHaveClass(/bg-pink-50/);
  await expect(takeawayNotice).toContainText(`Print failed · Order ORD-W-${run}`);
  await expect(
    page.locator('[data-testid="kds-message"][data-kind="emergency"]', { hasText: run }),
  ).toHaveCount(0);

  // Shown in the message bar only: no beep, nothing read out.
  await page.waitForTimeout(1500);
  const sound = await page.evaluate(() => {
    const w = window as unknown as { __spoken: string[]; __tones: number };
    return { spoken: w.__spoken, tones: w.__tones };
  });
  expect(sound).toEqual({ spoken: [], tones: 0 });

  // Print again: a failed try keeps the choice open, the next one clears the chip.
  await tableNotice.click();
  const dialog = page.getByTestId('kds-kot-dialog');
  await expect(dialog).toContainText(`Print failed · Table T${run}`);
  await dialog.getByTestId('kds-kot-reprint').click();
  await expect(dialog.getByTestId('kds-kot-failed')).toBeVisible();
  await expect(tableNotice).toHaveCount(1);
  await dialog.getByTestId('kds-kot-reprint').click();
  await expect(dialog).toBeHidden();
  await expect(tableNotice).toHaveCount(0);
  expect(reprintAttempts).toBe(2);

  // Cancel drops the warning without printing.
  await takeawayNotice.click();
  await dialog.getByTestId('kds-kot-drop').click();
  await expect(dialog).toBeHidden();
  await expect(takeawayNotice).toHaveCount(0);
  await expect.poll(() => dropped).toEqual([`12:Kitchen-${run}`]);
  expect(reprintAttempts).toBe(2);
});
