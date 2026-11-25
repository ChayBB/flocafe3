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
    await expect(page.getByTestId('table-staff-assignment-status')).toHaveText(
      'Managed by manager',
    );
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
    // Each staff card offers only the pencil; extra tables are typed in the range form.
    await expect(page.getByTestId(`staff-roster-add-${first.id}`)).toHaveCount(0);
    const handOut = async (memberId: string, kind: 'owner' | 'backup', tableIds: string[]) => {
      const res = await page.request.put(`${BASE}/api/tables/staff-tables`, {
        headers: authHeaders,
        data: { user_id: memberId, kind, table_ids: tableIds },
      });
      expect(res.ok()).toBeTruthy();
    };
    await handOut(first.id, 'owner', [tableA]);
    await handOut(first.id, 'backup', [tableB]);
    await handOut(second.id, 'owner', [tableA]);
    await page.reload();
    await page.getByTestId('tables-view-staff').click();
    await expect(page.getByTestId(`staff-roster-backup-${first.id}`)).toHaveText(
      `Backup tables ${nameB}`,
    );
    await expect(page.getByTestId(`staff-roster-tables-${second.id}`)).toContainText('Looks after');
    await expect(page.getByTestId(`staff-roster-tables-${second.id}`)).toContainText(nameA);
    await expect(page.getByTestId(`staff-roster-member-${absent}`)).toHaveAttribute(
      'aria-checked',
      'false',
    );
    const afterMove = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    const movedTable = afterMove.tables.find((table: { id: string }) => table.id === tableA);
    expect(movedTable.owner_user_id).toBe(second.id);
    const backupTable = afterMove.tables.find((table: { id: string }) => table.id === tableB);
    expect(backupTable.backup_user_id).toBe(first.id);

    const editDialog = page.getByTestId('staff-tables-edit-dialog');
    const rangeRow = (kind: 'primary' | 'backup', row: number) =>
      editDialog
        .getByTestId(`staff-range-${kind}`)
        .getByRole('textbox')
        .nth(row * 2);
    const fillRange = async (kind: 'primary' | 'backup', row: number, name: string) => {
      const from = rangeRow(kind, row);
      await from.fill(name);
      await editDialog
        .getByTestId(`staff-range-${kind}`)
        .getByRole('textbox')
        .nth(row * 2 + 1)
        .fill(name);
    };

    // The manager types ranges: A drops to a backup table and B becomes a main table.
    await page.getByTestId(`staff-roster-edit-${second.id}`).click();
    await expect(editDialog).toContainText(`Edit tables for ${second.name}`);
    await expect(rangeRow('primary', 0)).toHaveValue(nameA);
    await fillRange('primary', 0, nameB);
    await fillRange('backup', 0, nameA);
    await expect(editDialog.getByTestId('staff-range-unassigned')).toBeVisible();
    await editDialog.getByTestId('staff-range-save').click();
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

    // Taking a table another staff member looks after shows who holds it and asks first.
    await page.getByTestId(`staff-roster-edit-${first.id}`).click();
    await expect(rangeRow('backup', 0)).toHaveValue(nameB);
    await expect(editDialog.getByTestId('staff-range-backup-holder').first()).toHaveText(
      `Main staff: ${second.name}`,
    );
    await editDialog
      .getByTestId('staff-range-backup')
      .getByRole('button', { name: 'Remove this range' })
      .first()
      .click();
    await editDialog.getByRole('button', { name: 'Add main tables' }).click();
    const newRow =
      (await editDialog.getByTestId('staff-range-primary').getByRole('textbox').count()) / 2 - 1;
    await fillRange('primary', newRow, nameB);
    await editDialog.getByTestId('staff-range-save').click();
    await editDialog.screenshot({ path: test.info().outputPath('manager-range-form.png') });
    await expect(editDialog.getByTestId('staff-range-move-confirm')).toHaveText(
      `Move tables ${nameB} from ${second.name} to ${first.name}?`,
    );
    await editDialog.getByTestId('staff-range-save').click();
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
    await expect(page.getByTestId('table-staff-assignment-status')).toHaveText('Rotate daily');
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

test('the backup switch hides backup tables', async ({ page }) => {
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

    const dialog = page.getByTestId('staff-tables-edit-dialog');
    await page.getByTestId(`staff-roster-edit-${member.id}`).click();
    await expect(dialog.getByTestId('staff-range-backup')).toBeVisible();
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

    await page.getByTestId(`staff-roster-edit-${member.id}`).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('staff-range-backup')).toHaveCount(0);
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

test('re-zone previews one run of neighbouring tables per staff member', async ({ page }) => {
  const authHeaders = {
    Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
  };
  const created: string[] = [];
  const stamp = Date.now();
  for (const offset of [1, 2, 3]) {
    const res = await page.request.post(`${BASE}/api/tables`, {
      headers: authHeaders,
      data: { number: `E2E-ZONE-${stamp}-${offset}`, capacity: 2 },
    });
    expect(res.ok()).toBeTruthy();
    created.push((await res.json()).table.id);
  }
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
    const total = (roster.tables as unknown[]).length;
    const board = page.getByTestId('table-zone-board');
    await expect(board).toContainText('All tables by zone');
    const freeCard = board.getByTestId(`table-zone-board-table-E2E-ZONE-${stamp}-1`);
    await expect(freeCard).toContainText('Unassigned');
    await expect(freeCard).not.toHaveAttribute('data-table-owner');
    const panel = page.getByTestId('table-rezone');
    await expect(panel).toContainText('Re-zone tables');
    await expect(panel.getByTestId('table-rezone-current').first()).toBeVisible();

    const picked = (roster.staff as { present: boolean }[]).filter((m) => m.present).length;
    await panel.getByTestId('table-rezone-staff').fill(String(picked + 1));
    await expect(panel.getByTestId('table-rezone-staff-mismatch')).toContainText(
      `Staff today is ${picked + 1}, but only ${picked} staff are marked as working.`,
    );
    await expect(panel.getByTestId('table-rezone-apply')).toBeDisabled();
    await panel.getByTestId('table-rezone-staff').fill(String(picked));
    await expect(panel.getByTestId('table-rezone-staff-mismatch')).toHaveCount(0);
    const per = Math.ceil(total / picked);
    await expect(panel.getByTestId('table-rezone-per-staff')).toHaveAttribute(
      'placeholder',
      String(per),
    );
    await expect(panel.getByTestId('table-rezone-proposed')).toHaveCount(Math.ceil(total / per));
    await panel.getByTestId('table-rezone-per-staff').fill('1');
    await expect(panel.getByTestId('table-rezone-proposed')).toHaveCount(total);

    const skippedName = (roster.tables as { name: string }[])
      .map((table) => table.name)
      .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))[0];
    const skip = page.getByTestId('table-rezone-skip-setting');
    await expect(skip.getByTestId('table-rezone-skip-value')).toHaveText('None');
    await skip.getByTestId('table-rezone-skip-edit').click();
    await skip.getByTestId('table-rezone-skip').fill(skippedName);
    await expect(skip.getByTestId('table-rezone-skipped')).toContainText(skippedName);
    await expect(panel.getByTestId('table-rezone-proposed')).toHaveCount(total - 1);
    await skip.getByTestId('table-rezone-skip').fill(`${skippedName}, 99999`);
    await expect(skip.getByTestId('table-rezone-skip-save')).toBeEnabled();
    await expect(panel.getByTestId('table-rezone-proposed')).toHaveCount(total - 1);
    await skip.getByTestId('table-rezone-skip').fill(skippedName);
    await skip.getByTestId('table-rezone-skip-save').click();
    await expect(skip.getByTestId('table-rezone-skip-value')).toHaveText(skippedName);
    const savedRoster = await (
      await page.request.get(`${BASE}/api/tables/staff-roster`, { headers: authHeaders })
    ).json();
    expect(savedRoster.rezone_skip).toBe(skippedName);
    await skip.getByTestId('table-rezone-skip-edit').click();
    await skip.getByTestId('table-rezone-skip').fill('');
    await skip.getByTestId('table-rezone-skip-save').click();
    await expect(skip.getByTestId('table-rezone-skip-value')).toHaveText('None');
    await panel.getByTestId('table-rezone-per-staff').fill('1');

    await panel.getByTestId('table-rezone-apply').click();
    await expect(panel.getByTestId('table-rezone-confirm')).toContainText(
      `Rename the Floor Plan zones into ${total} zones?`,
    );
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByTestId('table-rezone-confirm')).toHaveCount(0);
  } finally {
    await page.request.put(`${BASE}/api/tables/rezone-skip`, {
      headers: authHeaders,
      data: { value: '' },
    });
    for (const id of created) {
      await page.request.delete(`${BASE}/api/tables/${id}`, { headers: authHeaders });
    }
  }
});
