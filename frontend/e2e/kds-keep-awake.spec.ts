import { test, expect, type Page } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';
import { getE2eToken } from './helpers/test-auth';

async function openKds(page: Page) {
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  await page.addInitScript(
    (accessToken: string) => localStorage.setItem('token', accessToken),
    token,
  );
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
}

test('the kitchen display holds a screen wake lock and plays the silent video where both are offered', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __wakeRequests: string[] };
    w.__wakeRequests = [];
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async (type: string) => {
          w.__wakeRequests.push(type);
          return { released: false, release: async () => {} };
        },
      },
    });
  });
  await openKds(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __wakeRequests: string[] }).__wakeRequests),
    )
    .toEqual(['screen']);
  const video = page.getByTestId('keep-screen-awake');
  await page.mouse.click(5, 5);
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused && el.loop))
    .toBe(true);
});

test('a kitchen display without a wake lock keeps awake with a silent looping video', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  });
  await openKds(page);
  const video = page.getByTestId('keep-screen-awake');
  await expect(video).toHaveCount(1);
  await page.mouse.click(5, 5);
  await expect
    .poll(() =>
      video.evaluate((el: HTMLVideoElement) => ({
        playing: !el.paused,
        loop: el.loop,
        muted: el.muted,
      })),
    )
    .toEqual({ playing: true, loop: true, muted: true });
});
