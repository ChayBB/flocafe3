import { expect, type Page } from '@playwright/test';

/** Staff land on their profile after signing in; Back opens the ordering screen. */
export async function leaveStaffProfile(page: Page): Promise<void> {
  const profile = page.getByTestId('server-app-staff-profile');
  await expect(profile).toBeVisible();
  await profile.locator('header').getByRole('button').first().click();
  await expect(profile).toHaveCount(0);
}

/** Shows the Server App's table list: a phone opens it with Select Table, a tablet always shows it. */
export async function openServerAppTables(page: Page): Promise<void> {
  const picker = page.getByTestId('server-app-table-picker');
  const button = page.getByTestId('server-app-table-button');
  const profile = page.getByTestId('server-app-staff-profile');
  await expect(picker.or(button).or(profile).first()).toBeVisible();
  if (await profile.isVisible()) await leaveStaffProfile(page);
  await expect(picker.or(button).first()).toBeVisible();
  if (!(await picker.isVisible())) {
    await button.click();
  }
  await expect(picker).toBeVisible();
}

export async function logoutServerApp(page: Page): Promise<void> {
  await page.getByTestId('server-app-staff-name').click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
}
