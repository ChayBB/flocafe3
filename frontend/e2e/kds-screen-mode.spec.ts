import { test, expect, type Page } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';

async function openKds(page: Page) {
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
}

const screen = (page: Page) =>
  page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    background: getComputedStyle(document.body).backgroundColor,
  }));

const dimming = (page: Page) =>
  page.evaluate(() => {
    const dimmer = document.querySelector<HTMLElement>('[data-testid=kds-dimmer]');
    return dimmer ? Number(getComputedStyle(dimmer).opacity) : 0;
  });

test('the header AA button replaces the day/night toggle and changes the text size', async ({
  page,
}) => {
  await openKds(page);
  await page.evaluate(() => localStorage.removeItem('flocafe:kds-font-scale'));
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByTestId('kds-screen-mode-toggle')).toHaveCount(0);
  const rootFont = () =>
    page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const normal = await rootFont();

  const button = page.getByTestId('kds-font-size-button');
  await expect(button).toHaveAccessibleName('Text size');
  await button.click();
  const panel = page.getByTestId('kds-font-size-panel');
  await expect(panel.getByTestId('kds-header-font-scale-value')).toHaveText('100%');
  await panel.getByTestId('kds-header-font-larger').click();
  await expect(panel.getByTestId('kds-header-font-scale-value')).toHaveText('110%');
  await expect.poll(rootFont).toBeCloseTo(normal * 1.1);

  // The settings dialog shows the same size, since both change this display's one setting.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.getByTestId('kds-settings-button').click();
  await expect(
    page.getByTestId('kds-settings-dialog').getByTestId('kds-font-scale-value'),
  ).toHaveText('110%');
});

test('each KDS display picks day or night and a brightness, and keeps both over the app theme', async ({
  page,
}) => {
  // The app itself is dark on this device, so a display that never chose starts at night.
  await page.emulateMedia({ colorScheme: 'dark' });
  await openKds(page);
  await expect.poll(() => screen(page)).toEqual({ dark: true, background: 'rgb(32, 32, 32)' });
  expect(await dimming(page)).toBe(0);

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  await expect(dialog.getByRole('radio')).toHaveText(['Day', 'Night']);
  await expect(dialog.getByTestId('kds-screen-mode-night')).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByTestId('kds-brightness-value')).toHaveText('100%');

  await dialog.getByTestId('kds-screen-mode-day').click();
  await expect.poll(() => screen(page)).toEqual({ dark: false, background: 'rgb(220, 217, 210)' });

  // Any whole percent from 20% to 100%; lower brightness dims the board.
  const slider = dialog.getByTestId('kds-brightness');
  await expect(slider).toHaveAttribute('min', '20');
  await expect(slider).toHaveAttribute('max', '100');
  await expect(slider).toHaveAttribute('step', '1');
  await slider.fill('43');
  await expect(dialog.getByTestId('kds-brightness-value')).toHaveText('43%');
  await expect.poll(() => dimming(page)).toBeCloseTo(0.57);
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByTestId('kds-brightness-value')).toHaveText('44%');

  // Both choices belong to this display and survive a reload, even with the app theme now light.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByTestId('kds-screen-mode-night').click();
  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect.poll(() => screen(page)).toEqual({ dark: true, background: 'rgb(32, 32, 32)' });
  await expect.poll(() => dimming(page)).toBeCloseTo(0.56);

  await page.getByTestId('kds-settings-button').click();
  await dialog.getByTestId('kds-brightness').fill('100');
  await expect.poll(() => dimming(page)).toBe(0);
});

test('the text size buttons above brightness grow and shrink the KDS text, kept per display', async ({
  page,
}) => {
  await openKds(page);
  await page.evaluate(() => localStorage.removeItem('flocafe:kds-font-scale'));
  await page.reload();
  const rootFont = () =>
    page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const normal = await rootFont();

  await page.getByTestId('kds-settings-button').click();
  const dialog = page.getByTestId('kds-settings-dialog');
  const value = dialog.getByTestId('kds-font-scale-value');
  await expect(value).toHaveText('100%');
  const fontBox = await dialog.getByTestId('kds-font-larger').boundingBox();
  const brightnessBox = await dialog.getByTestId('kds-brightness').boundingBox();
  expect(fontBox!.y).toBeLessThan(brightnessBox!.y);

  await dialog.getByTestId('kds-font-larger').click();
  await dialog.getByTestId('kds-font-larger').click();
  await expect(value).toHaveText('120%');
  await expect.poll(rootFont).toBeCloseTo(normal * 1.2);

  for (let step = 0; step < 12; step++)
    await dialog.getByTestId('kds-font-larger').click({ force: true });
  await expect(value).toHaveText('200%');
  await expect(dialog.getByTestId('kds-font-larger')).toBeDisabled();

  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect.poll(rootFont).toBeCloseTo(normal * 2);

  await page.getByTestId('kds-settings-button').click();
  for (let step = 0; step < 12; step++) await dialog.getByTestId('kds-font-smaller').click();
  await expect(value).toHaveText('80%');
  await expect(dialog.getByTestId('kds-font-smaller')).toBeDisabled();
  await expect.poll(rootFont).toBeCloseTo(normal * 0.8);
});
