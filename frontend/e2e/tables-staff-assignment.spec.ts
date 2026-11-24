import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('manager picks a table staff assignment mode from the Tables page tab', async ({ page }) => {
  test.setTimeout(90_000);
  const authHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const before = await page.request.get(`${BASE}/api/tables/owner-assignment`, {
    headers: authHeaders,
  });
  expect(before.ok()).toBeTruthy();
  const original = await before.json();
  const createdTables: string[] = [];
  const createdNames: string[] = [];
  const ownersBefore = new Map<string, string | null>();

  try {
    for (const suffix of ['A', 'B']) {
      const number = `E2E-ROSTER-${suffix}-${Date.now()}`;
      const created = await page.request.post(`${BASE}/api/tables`, {
        headers: authHeaders,
        data: { number, capacity: 2 },
      });
      expect(created.ok()).toBeTruthy();
      createdTables.push((await created.json()).table.id);
      createdNames.push(number);
    }
    const tablesBefore = await (
      await page.request.get(`${BASE}/api/tables`, { headers: authHeaders })
    ).json();
    for (const table of tablesBefore.tables as { id: string; owner_user_id: string | null }[]) {
      ownersBefore.set(table.id, table.owner_user_id ?? null);
    }
    const reset = await page.request.put(`${BASE}/api/tables/owner-assignment`, {
      headers: authHeaders,
      data: { mode: 'manual', shuffle_days: 7 },
    });
    expect(reset.ok()).toBeTruthy();

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/tables`);

    await page.getByTestId('tables-view-staff').click();
    const card = page.getByTestId('table-staff-assignment');
    await expect(card).toContainText('Table Staff Assignment');
    await expect(card).toContainText('Assignment mode');
    await expect(page.getByTestId('table-staff-assignment-status')).toHaveText('Off');
    await expect(page.getByTestId('staff-assignment-mode-manual')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const save = page.getByTestId('staff-assignment-save');
    await expect(save).toBeDisabled();

    const roster = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    const total = roster.staff.length as number;
    expect(total).toBeGreaterThan(1);
    await expect(page.getByTestId('staff-roster')).toContainText('Staff working today');
    await expect(page.getByTestId('staff-roster-date')).not.toBeEmpty();
    await expect(page.getByTestId('staff-roster-count')).toHaveText(`${total} of ${total} in`);
    await expect(page.getByTestId('staff-roster-table-count')).toHaveValue(
      String(roster.table_count_default),
    );

    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.getByTestId('staff-roster-count')).toHaveText(`0 of ${total} in`);
    await expect(page.getByTestId('staff-roster-split')).toHaveText(
      'Select the staff working today',
    );
    await page.getByRole('button', { name: 'Select all' }).click();
    const absent = roster.staff[0].id as string;
    const absentCard = page.getByTestId(`staff-roster-member-${absent}`);
    await absentCard.click();
    await expect(absentCard).toHaveAttribute('aria-checked', 'false');
    await expect(absentCard).toContainText('Off / leave');
    await expect(page.getByTestId('staff-roster-count')).toHaveText(`${total - 1} of ${total} in`);

    const tables = (roster.table_count_default as number) - 1;
    await page.getByTestId('staff-roster-table-count').fill(String(tables));
    const presentCount = total - 1;
    await expect(page.getByTestId('staff-roster-summary-staff')).toHaveText(String(presentCount));
    await expect(page.getByTestId('staff-roster-summary-tables')).toHaveText(String(tables));
    await expect(page.getByTestId('staff-roster-summary-average')).toHaveText(
      String(Number((tables / presentCount).toFixed(1))),
    );
    const low = Math.floor(tables / presentCount);
    const extra = tables % presentCount;
    const people = (n: number, verb: string) =>
      n === 1 ? `1 person ${verb}` : `${n} people ${verb}`;
    const tablesText = (n: number) => (n === 1 ? '1 table' : `${n} tables`);
    await expect(page.getByTestId('staff-roster-split')).toHaveText(
      extra === 0
        ? `${presentCount === 1 ? '1 person looks' : `${presentCount} people each look`} after ${tablesText(low)}`
        : `${people(presentCount - extra, presentCount - extra === 1 ? 'looks' : 'look')} after ${tablesText(low)} and ${people(extra, extra === 1 ? 'looks' : 'look')} after ${tablesText(low + 1)}`,
    );

    const rosterSaved = page.waitForResponse(
      (res) => res.url().includes('/api/tables/staff-roster') && res.request().method() === 'PUT',
    );
    await save.click();
    expect((await rosterSaved).ok()).toBeTruthy();
    await expect(save).toBeDisabled();
    const storedRoster = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    expect(storedRoster.table_count).toBe(tables);
    expect(storedRoster.table_count_custom).toBe(true);
    expect(storedRoster.staff.find((m: { id: string }) => m.id === absent).present).toBe(false);
    await page.reload();
    await page.getByTestId('tables-view-staff').click();
    await expect(page.getByTestId('staff-roster-count')).toHaveText(`${total - 1} of ${total} in`);

    const first = roster.staff[0] as { id: string; name: string };
    const second = roster.staff[1] as { id: string; name: string };
    const [tableA, tableB] = createdTables;
    const [nameA, nameB] = createdNames;
    const dialog = page.getByTestId('staff-tables-dialog');
    const handOut = async (memberId: string, kind: 'owner' | 'backup', tableIds: string[]) => {
      await page.getByTestId(`staff-roster-add-${memberId}`).click();
      await page.getByTestId(`staff-tables-kind-${kind}`).click();
      for (const id of tableIds) await page.getByTestId(`staff-tables-option-${id}`).check();
    };

    await handOut(first.id, 'owner', [tableA]);
    await page.getByTestId('staff-tables-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`staff-roster-tables-${first.id}`)).toContainText('Looks after');
    await expect(page.getByTestId(`staff-roster-tables-${first.id}`)).toContainText(nameA);
    await expect(page.getByTestId(`staff-roster-member-${absent}`)).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await handOut(first.id, 'backup', [tableB]);
    await expect(page.getByTestId(`staff-tables-option-${tableA}`)).toBeDisabled();
    await page.getByTestId('staff-tables-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`staff-roster-backup-${first.id}`)).toHaveText(
      `Backup tables ${nameB}`,
    );

    await handOut(second.id, 'owner', [tableA]);
    await page.getByTestId('staff-tables-submit').click();
    await expect(page.getByTestId('staff-tables-confirm')).toHaveText(
      `Move tables ${nameA} from ${first.name} to ${second.name}?`,
    );
    await page.getByTestId('staff-tables-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`staff-roster-tables-${second.id}`)).toContainText(nameA);
    await expect(
      page.getByTestId(`staff-roster-tables-${first.id}`).filter({ hasText: nameA }),
    ).toHaveCount(0);
    const afterMove = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    const movedTable = afterMove.tables.find((table: { id: string }) => table.id === tableA);
    expect(movedTable.owner_user_id).toBe(second.id);
    const backupTable = afterMove.tables.find((table: { id: string }) => table.id === tableB);
    expect(backupTable.backup_user_id).toBe(first.id);

    const editDialog = page.getByTestId('staff-tables-edit-dialog');
    await page.getByTestId(`staff-roster-edit-${second.id}`).click();
    await expect(page.getByTestId(`staff-tables-edit-owner-${tableA}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByTestId(`staff-tables-edit-backup-${tableA}`).click();
    await expect(page.getByTestId(`staff-tables-edit-holder-${tableA}`)).toHaveText('No one yet');
    await page.getByTestId(`staff-tables-edit-owner-${tableB}`).click();
    await page.getByTestId('staff-tables-edit-submit').click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByTestId(`staff-roster-backup-${second.id}`)).toContainText(nameA);
    await expect(page.getByTestId(`staff-roster-tables-${second.id}`)).toContainText(nameB);
    let edited = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    const byId = (id: string) =>
      edited.tables.find((table: { id: string }) => table.id === id) as {
        owner_user_id: string | null;
        backup_user_id: string | null;
      };
    expect(byId(tableA).owner_user_id).toBeNull();
    expect(byId(tableA).backup_user_id).toBe(second.id);
    expect(byId(tableB).owner_user_id).toBe(second.id);
    expect(byId(tableB).backup_user_id).toBe(first.id);

    await page.getByTestId(`staff-roster-edit-${first.id}`).click();
    await expect(page.getByTestId(`staff-tables-edit-backup-${tableB}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByTestId(`staff-tables-edit-owner-${tableB}`).click();
    await page.getByTestId('staff-tables-edit-submit').click();
    await expect(page.getByTestId('staff-tables-edit-confirm')).toHaveText(
      `Move tables ${nameB} from ${second.name} to ${first.name}?`,
    );
    await page.getByTestId('staff-tables-edit-submit').click();
    await expect(editDialog).toBeHidden();
    edited = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    expect(byId(tableB).owner_user_id).toBe(first.id);
    expect(byId(tableB).backup_user_id).toBeNull();
    await expect(page.getByTestId(`staff-roster-tables-${first.id}`)).toContainText(nameB);

    const modeSaved = () =>
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/tables/owner-assignment') && res.request().method() === 'PUT',
      );
    await page.getByTestId('staff-assignment-mode-rotate_daily').click();
    const confirmDialog = page.getByTestId('staff-assignment-confirm');
    await expect(confirmDialog).toContainText(
      `Reassign today’s tables now among the ${total - 1} staff members marked as working?`,
    );
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByTestId('staff-assignment-mode-manual')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.getByTestId('staff-assignment-mode-rotate_daily').click();
    let modeResponse = modeSaved();
    await page.getByTestId('staff-assignment-confirm-run').click();
    expect((await modeResponse).ok()).toBeTruthy();
    await expect(page.getByText(/Tables assigned for today/)).toBeVisible();
    await expect(page.getByTestId('table-staff-assignment-status')).toHaveText('Enabled');
    await expect(page.getByTestId(`staff-roster-edit-${second.id}`)).toHaveCount(0);
    let stored = await (
      await page.request.get(`${BASE}/api/tables/owner-assignment`, { headers: authHeaders })
    ).json();
    expect(stored.mode).toBe('rotate_daily');
    const afterRun = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    const servedCount = afterRun.table_count as number;
    const presentStaff = (
      afterRun.staff as {
        id: string;
        present: boolean;
        tables: unknown[];
        backup_tables: unknown[];
      }[]
    ).filter((member) => member.present);
    const runLow = Math.floor(servedCount / presentStaff.length);
    for (const member of presentStaff) {
      expect(member.tables.length).toBeGreaterThanOrEqual(runLow);
      expect(member.tables.length).toBeLessThanOrEqual(runLow + 1);
      if (member.tables.length > 0) {
        await expect(page.getByTestId(`staff-roster-tables-${member.id}`)).toContainText(
          'Looks after',
        );
      }
      if (member.backup_tables.length > 0) {
        await expect(page.getByTestId(`staff-roster-backup-${member.id}`)).toContainText(
          'Backup tables',
        );
      }
    }
    expect(presentStaff.some((member) => member.backup_tables.length > 0)).toBe(true);
    await expect(page.getByTestId(`staff-roster-tables-${absent}`)).toHaveCount(0);
    await expect(page.getByTestId(`staff-roster-backup-${absent}`)).toHaveCount(0);

    await page.getByTestId('staff-assignment-mode-shuffle_interval').click();
    modeResponse = modeSaved();
    await page.getByTestId('staff-assignment-confirm-run').click();
    expect((await modeResponse).ok()).toBeTruthy();
    await expect(page.getByTestId('staff-assignment-mode-shuffle_interval')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const daysInput = page.getByTestId('staff-assignment-shuffle-days');
    await daysInput.fill('0');
    await expect(card).toContainText('Enter a whole number of days from 1 to 365');
    await expect(save).toBeDisabled();
    await daysInput.fill('5');
    const saved = modeSaved();
    await save.click();
    expect((await saved).ok()).toBeTruthy();
    stored = await (
      await page.request.get(`${BASE}/api/tables/owner-assignment`, { headers: authHeaders })
    ).json();
    expect(stored.mode).toBe('shuffle_interval');
    expect(stored.shuffle_days).toBe(5);

    await page.reload();
    await page.getByTestId('tables-view-staff').click();
    await expect(page.getByTestId('staff-assignment-shuffle-days')).toHaveValue('5');
    await expect(page.getByTestId(`staff-roster-edit-${second.id}`)).toHaveCount(0);
  } finally {
    const rosterNow = await page.request
      .get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
      .then((res) => res.json())
      .catch(() => null);
    if (rosterNow?.staff?.length) {
      // One present person in an automatic mode leaves no backups behind.
      await page.request
        .put(`${BASE}/api/tables/staff-roster`, {
          headers: authHeaders,
          data: { present_user_ids: [rosterNow.staff[0].id], table_count: null },
        })
        .catch(() => {});
    }
    await page.request
      .put(`${BASE}/api/tables/owner-assignment`, {
        headers: authHeaders,
        data: { mode: 'manual', shuffle_days: original.shuffle_days },
      })
      .catch(() => {});
    for (const [id, ownerId] of ownersBefore) {
      await page.request
        .put(`${BASE}/api/tables/${id}/owner`, { headers: authHeaders, data: { user_id: ownerId } })
        .catch(() => {});
    }
    if (rosterNow?.staff?.length) {
      await page.request
        .put(`${BASE}/api/tables/staff-roster`, {
          headers: authHeaders,
          data: {
            present_user_ids: rosterNow.staff.map((m: { id: string }) => m.id),
            table_count: null,
          },
        })
        .catch(() => {});
    }
    for (const id of createdTables) {
      await page.request
        .delete(`${BASE}/api/tables/${id}`, { headers: authHeaders })
        .catch(() => {});
    }
    await page.request
      .put(`${BASE}/api/tables/owner-assignment`, {
        headers: authHeaders,
        data: { mode: original.mode, shuffle_days: original.shuffle_days },
      })
      .catch(() => {});
  }
});

test('add-tables dialog uses the brand colour and the backup switch hides backup tables', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const authHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const number = `E2E-BACKUP-${Date.now()}`;
  const created = await page.request.post(`${BASE}/api/tables`, {
    headers: authHeaders,
    data: { number, capacity: 2 },
  });
  expect(created.ok()).toBeTruthy();
  const tableId = (await created.json()).table.id as string;

  try {
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/tables`);
    await page.getByTestId('tables-view-staff').click();

    const roster = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    expect(roster.backup_enabled).toBe(true);
    const member = roster.staff[0] as { id: string };
    const toggle = page.getByTestId('staff-backup-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('staff-backup-setting')).toContainText('Use backup tables');

    const dialog = page.getByTestId('staff-tables-dialog');
    await page.getByTestId(`staff-roster-add-${member.id}`).click();
    await expect(page.getByTestId('staff-tables-kind-owner')).toHaveClass(/bg-brand/);
    await expect(page.getByTestId('staff-tables-kind-backup')).not.toHaveClass(/bg-brand/);
    const submit = page.getByTestId('staff-tables-submit');
    await expect(submit).toHaveClass(/bg-brand/);
    await expect(submit).toBeDisabled();
    await page.getByTestId(`staff-tables-option-${tableId}`).check();
    await expect(page.getByTestId(`staff-tables-row-${tableId}`)).toHaveAttribute(
      'data-selected',
      'true',
    );
    await expect(page.getByTestId(`staff-tables-option-${tableId}`)).toHaveClass(/accent-brand/);
    await expect(submit).toBeEnabled();
    await page.getByTestId('staff-tables-kind-backup').click();
    await expect(page.getByTestId('staff-tables-kind-backup')).toHaveClass(/bg-brand/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // A backend that ignores the switch (Flo not restarted) must not report success.
    const dropSwitch = async (route: import('@playwright/test').Route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.backup_enabled;
      if (route.request().method() === 'PUT') {
        await page.request.put(`${BASE}/api/tables/owner-assignment`, {
          headers: authHeaders,
          data: { backup_enabled: true },
        });
      }
      await route.fulfill({ response, json: body });
    };
    await page.route('**/api/tables/owner-assignment', dropSwitch);
    await page.route('**/api/tables/staff-roster', dropSwitch);
    await toggle.click();
    await expect(
      page.getByText('Backup tables setting was not saved', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('Backup tables turned off')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.unroute('**/api/tables/owner-assignment');
    await page.unroute('**/api/tables/staff-roster');

    const switched = page.waitForResponse(
      (res) =>
        res.url().includes('/api/tables/owner-assignment') && res.request().method() === 'PUT',
    );
    await toggle.click();
    expect((await switched).ok()).toBeTruthy();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('Backup tables turned off')).toHaveCount(1);
    const stored = await (
      await page.request.get(`${BASE}/api/tables/owner-assignment`, { headers: authHeaders })
    ).json();
    expect(stored.backup_enabled).toBe(false);

    await page.getByTestId(`staff-roster-add-${member.id}`).click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('staff-tables-kind-backup')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.reload();
    await page.getByTestId('tables-view-staff').click();
    await expect(page.getByTestId('staff-backup-toggle')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('staff-backup-toggle').click();
    await expect(page.getByTestId('staff-backup-toggle')).toHaveAttribute('aria-checked', 'true');
  } finally {
    await page.request
      .put(`${BASE}/api/tables/owner-assignment`, {
        headers: authHeaders,
        data: { backup_enabled: true },
      })
      .catch(() => {});
    await page.request
      .delete(`${BASE}/api/tables/${tableId}`, { headers: authHeaders })
      .catch(() => {});
  }
});
