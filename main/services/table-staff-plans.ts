import { randomUUID } from 'crypto';
import { getDatabase, now } from '../db';
import { currentBusinessDate } from './attendance';
import {
  activeTablesInOrder,
  readTableOwnerAssignmentSettings,
  readTableStaffRoster,
  setTableStaff,
  updateTableOwnerAssignmentSettings,
  zoneRuns,
  type ActiveTable,
  type TableAssignmentChange,
} from './table-owner-rotation';

type Db = ReturnType<typeof getDatabase>;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const PLAN_NAME_MAX = 60;
export const PLAN_NOTE_MAX = 200;
export const PLAN_STAFF_MAX = 999;

interface PlanRow {
  id: string;
  letter: string;
  name: string;
  staff_min: number | null;
  staff_max: number | null;
  condition_note: string | null;
  auto_assign: number;
  sort_order: number;
  updated_at: string;
}

interface PlanTableRow {
  table_id: string;
  active: number;
  owner_user_id: string | null;
  backup_user_id: string | null;
}

export interface TableStaffPlan {
  id: string;
  letter: string;
  name: string;
  staff_min: number | null;
  staff_max: number | null;
  condition_note: string | null;
  auto_assign: boolean;
  sort_order: number;
  updated_at: string;
  table_count: number;
  zone_count: number;
  people: { id: string; name: string; part_time: boolean }[];
}

export interface TableStaffPlanInput {
  name: string;
  staff_min: number | null;
  staff_max: number | null;
  condition_note: string | null;
  auto_assign: boolean;
}

export type PlanInputValidation =
  | ({ ok: true } & TableStaffPlanInput)
  | { ok: false; code: string; error: string };

function staffBound(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= PLAN_STAFF_MAX
    ? (value as number)
    : undefined;
}

export function validatePlanInput(body: unknown): PlanInputValidation {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > PLAN_NAME_MAX) {
    return { ok: false, code: 'PLAN_NAME_INVALID', error: 'Plan name is required (max 60)' };
  }
  const staffMin = staffBound(input.staff_min);
  const staffMax = staffBound(input.staff_max);
  if (staffMin === undefined || staffMax === undefined) {
    return { ok: false, code: 'PLAN_STAFF_INVALID', error: 'Staff counts must be 0-999' };
  }
  if (staffMin !== null && staffMax !== null && staffMin > staffMax) {
    return { ok: false, code: 'PLAN_STAFF_RANGE', error: 'Minimum staff exceeds maximum' };
  }
  const note =
    input.condition_note === undefined || input.condition_note === null
      ? ''
      : String(input.condition_note).trim();
  if (note.length > PLAN_NOTE_MAX) {
    return { ok: false, code: 'PLAN_NOTE_INVALID', error: 'Condition note is too long' };
  }
  if (input.auto_assign !== undefined && typeof input.auto_assign !== 'boolean') {
    return { ok: false, code: 'PLAN_AUTO_INVALID', error: 'auto_assign must be a boolean' };
  }
  return {
    ok: true,
    name,
    staff_min: staffMin,
    staff_max: staffMax,
    condition_note: note || null,
    auto_assign: input.auto_assign === true,
  };
}

function planRow(db: Db, id: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM table_staff_plans WHERE id = ?').get(id) as PlanRow | undefined;
}

function planTables(db: Db, planId: string): PlanTableRow[] {
  return db
    .prepare(
      'SELECT table_id, active, owner_user_id, backup_user_id FROM table_staff_plan_tables WHERE plan_id = ?',
    )
    .all(planId) as PlanTableRow[];
}

function snapshotTables(db: Db, planId: string, autoAssign: boolean): void {
  db.prepare('DELETE FROM table_staff_plan_tables WHERE plan_id = ?').run(planId);
  const insert = db.prepare(
    `INSERT INTO table_staff_plan_tables (plan_id, table_id, active, owner_user_id, backup_user_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const rows = db
    .prepare('SELECT id, is_active, owner_user_id, backup_user_id FROM tables')
    .all() as {
    id: string;
    is_active: number;
    owner_user_id: string | null;
    backup_user_id: string | null;
  }[];
  for (const row of rows) {
    const keepPeople = !autoAssign && row.is_active === 1;
    insert.run(
      planId,
      row.id,
      row.is_active === 1 ? 1 : 0,
      keepPeople ? row.owner_user_id : null,
      keepPeople ? row.backup_user_id : null,
    );
  }
}

function nextLetter(db: Db): string {
  const used = new Set(
    (db.prepare('SELECT letter FROM table_staff_plans').all() as { letter: string }[]).map(
      (row) => row.letter,
    ),
  );
  for (const letter of LETTERS) if (!used.has(letter)) return letter;
  let index = 2;
  while (used.has(`Z${index}`)) index += 1;
  return `Z${index}`;
}

export function listTableStaffPlans(db: Db): TableStaffPlan[] {
  const rows = db
    .prepare('SELECT * FROM table_staff_plans ORDER BY sort_order, letter COLLATE NOCASE, id')
    .all() as PlanRow[];
  const users = new Map(
    (
      db.prepare('SELECT id, name, part_time FROM users').all() as {
        id: string;
        name: string;
        part_time: number;
      }[]
    ).map((user) => [user.id, user]),
  );
  const floors = new Map(
    (
      db.prepare('SELECT id, floor FROM tables').all() as { id: string; floor: string | null }[]
    ).map((table) => [table.id, (table.floor ?? '').trim()]),
  );
  return rows.map((row) => {
    const tables = planTables(db, row.id).filter(
      (table) => table.active === 1 && floors.has(table.table_id),
    );
    const peopleIds = [
      ...new Set(
        tables
          .flatMap((table) => [table.owner_user_id, table.backup_user_id])
          .filter((id): id is string => Boolean(id && users.has(id))),
      ),
    ];
    return {
      id: row.id,
      letter: row.letter,
      name: row.name,
      staff_min: row.staff_min,
      staff_max: row.staff_max,
      condition_note: row.condition_note,
      auto_assign: row.auto_assign === 1,
      sort_order: row.sort_order,
      updated_at: row.updated_at,
      table_count: tables.length,
      zone_count: new Set(tables.map((table) => floors.get(table.table_id))).size,
      people: peopleIds.map((id) => {
        const user = users.get(id)!;
        return { id, name: user.name, part_time: user.part_time === 1 };
      }),
    };
  });
}

/** The plan whose staff range fits today's attendance; people-based plans win over automatic ones. */
export function suggestTableStaffPlan(
  plans: TableStaffPlan[],
  presentCount: number,
): string | null {
  const fits = plans.filter(
    (plan) =>
      (plan.staff_min !== null || plan.staff_max !== null) &&
      (plan.staff_min ?? 0) <= presentCount &&
      presentCount <= (plan.staff_max ?? Number.MAX_SAFE_INTEGER),
  );
  const width = (plan: TableStaffPlan) =>
    (plan.staff_max ?? PLAN_STAFF_MAX) - (plan.staff_min ?? 0);
  fits.sort(
    (a, b) =>
      Number(a.auto_assign) - Number(b.auto_assign) ||
      width(a) - width(b) ||
      a.sort_order - b.sort_order,
  );
  return fits[0]?.id ?? null;
}

export function createTableStaffPlan(
  db: Db,
  input: TableStaffPlanInput,
  actorUserId: string,
): string {
  const id = randomUUID();
  db.transaction(() => {
    const order =
      (db.prepare('SELECT MAX(sort_order) AS top FROM table_staff_plans').get() as { top: number })
        .top ?? -1;
    db.prepare(
      `INSERT INTO table_staff_plans
         (id, letter, name, staff_min, staff_max, condition_note, auto_assign, sort_order,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      nextLetter(db),
      input.name,
      input.staff_min,
      input.staff_max,
      input.condition_note,
      input.auto_assign ? 1 : 0,
      order + 1,
      actorUserId,
      now(),
      now(),
    );
    snapshotTables(db, id, input.auto_assign);
  })();
  return id;
}

export function updateTableStaffPlan(
  db: Db,
  id: string,
  input: TableStaffPlanInput & { resnapshot: boolean },
): boolean {
  const before = planRow(db, id);
  if (!before) return false;
  db.transaction(() => {
    db.prepare(
      `UPDATE table_staff_plans
         SET name = ?, staff_min = ?, staff_max = ?, condition_note = ?, auto_assign = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.staff_min,
      input.staff_max,
      input.condition_note,
      input.auto_assign ? 1 : 0,
      now(),
      id,
    );
    if (input.resnapshot) {
      snapshotTables(db, id, input.auto_assign);
    } else if (input.auto_assign && before.auto_assign === 0) {
      db.prepare(
        'UPDATE table_staff_plan_tables SET owner_user_id = NULL, backup_user_id = NULL WHERE plan_id = ?',
      ).run(id);
    }
  })();
  return true;
}

export function duplicateTableStaffPlan(db: Db, id: string, actorUserId: string): string | null {
  const source = planRow(db, id);
  if (!source) return null;
  const copyId = randomUUID();
  db.transaction(() => {
    const order =
      (db.prepare('SELECT MAX(sort_order) AS top FROM table_staff_plans').get() as { top: number })
        .top ?? -1;
    db.prepare(
      `INSERT INTO table_staff_plans
         (id, letter, name, staff_min, staff_max, condition_note, auto_assign, sort_order,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      copyId,
      nextLetter(db),
      source.name.slice(0, PLAN_NAME_MAX),
      source.staff_min,
      source.staff_max,
      source.condition_note,
      source.auto_assign,
      order + 1,
      actorUserId,
      now(),
      now(),
    );
    db.prepare(
      `INSERT INTO table_staff_plan_tables (plan_id, table_id, active, owner_user_id, backup_user_id)
       SELECT ?, table_id, active, owner_user_id, backup_user_id
       FROM table_staff_plan_tables WHERE plan_id = ?`,
    ).run(copyId, id);
  })();
  return copyId;
}

export function deleteTableStaffPlan(db: Db, id: string): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM table_staff_plan_tables WHERE plan_id = ?').run(id);
    return db.prepare('DELETE FROM table_staff_plans WHERE id = ?').run(id).changes > 0;
  })();
}

export interface PlanApplyResult {
  plan_id: string;
  changes: TableAssignmentChange[];
  absent: { id: string; name: string }[];
  filled_tables: string[];
  activated_tables: string[];
  deactivated_tables: string[];
  busy_tables: string[];
}

function tableIsBusy(db: Db, tableId: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM orders WHERE table_id = ? AND status NOT IN ('completed', 'cancelled') LIMIT 1",
      )
      .get(tableId) || db.prepare('SELECT 1 FROM held_orders WHERE table_id = ?').get(tableId),
  );
}

function zonesOf(tables: ActiveTable[]): ActiveTable[][] {
  const zones: ActiveTable[][] = [];
  for (const table of tables) {
    const last = zones[zones.length - 1];
    if (last && (last[0].floor ?? '').trim() === (table.floor ?? '').trim()) last.push(table);
    else zones.push([table]);
  }
  return zones;
}

/**
 * Turns the plan's tables on or off, then gives each table its planned main and backup when they
 * are working today. An absent main hands the table to its planned backup; tables still without a
 * main go to the people not used by the plan (zone rule), or to the least-loaded main.
 */
export function applyTableStaffPlan(
  db: Db,
  id: string,
  actorUserId: string,
  businessDate = currentBusinessDate(db),
): PlanApplyResult | null {
  const plan = planRow(db, id);
  if (!plan) return null;
  return db.transaction(() => {
    const settings = readTableOwnerAssignmentSettings(db);
    if (settings.mode === 'rotate_daily' || settings.mode === 'shuffle_interval') {
      updateTableOwnerAssignmentSettings(
        db,
        { mode: 'manual', shuffle_days: settings.shuffle_days },
        actorUserId,
      );
    }
    const snapshot = new Map(planTables(db, id).map((row) => [row.table_id, row]));
    const activated: string[] = [];
    const deactivated: string[] = [];
    const busy: string[] = [];
    const existing = db.prepare('SELECT id, is_active FROM tables').all() as {
      id: string;
      is_active: number;
    }[];
    for (const table of existing) {
      const row = snapshot.get(table.id);
      if (!row || row.active === table.is_active) continue;
      if (row.active === 0 && tableIsBusy(db, table.id)) {
        busy.push(table.id);
        continue;
      }
      db.prepare('UPDATE tables SET is_active = ?, updated_at = ? WHERE id = ?').run(
        row.active,
        now(),
        table.id,
      );
      (row.active === 1 ? activated : deactivated).push(table.id);
    }

    const roster = readTableStaffRoster(db, businessDate);
    const present = new Set(roster.staff.filter((m) => m.present).map((m) => m.id));
    const tables = activeTablesInOrder(db);
    const next = new Map<string, { owner: string | null; backup: string | null }>();
    const absent = new Set<string>();
    for (const table of tables) {
      const row = plan.auto_assign === 1 ? undefined : snapshot.get(table.id);
      const planned = { owner: row?.owner_user_id ?? null, backup: row?.backup_user_id ?? null };
      for (const person of [planned.owner, planned.backup]) {
        if (person && !present.has(person)) absent.add(person);
      }
      next.set(table.id, {
        owner: planned.owner && present.has(planned.owner) ? planned.owner : null,
        backup: planned.backup && present.has(planned.backup) ? planned.backup : null,
      });
    }

    const gaps = tables.filter((table) => !next.get(table.id)!.owner);
    const filled = gaps.map((table) => table.id);
    const mains = new Set([...next.values()].map((v) => v.owner).filter(Boolean) as string[]);
    const free = roster.staff.filter((m) => m.present && !mains.has(m.id)).map((m) => m.id);
    if (gaps.length > 0 && free.length > 0) {
      let index = 0;
      for (const group of zoneRuns(gaps, free.length)) {
        for (const run of group) {
          const owner = free[index++];
          for (const table of run) next.get(table.id)!.owner = owner;
        }
      }
    } else if (gaps.length > 0) {
      for (const table of gaps) {
        const value = next.get(table.id)!;
        if (value.backup) [value.owner, value.backup] = [value.backup, null];
      }
      const load = new Map([...mains].map((person) => [person, 0]));
      for (const value of next.values()) {
        if (value.owner) load.set(value.owner, (load.get(value.owner) ?? 0) + 1);
      }
      for (const zone of zonesOf(gaps.filter((table) => !next.get(table.id)!.owner))) {
        if (load.size === 0) break;
        const owner = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
        for (const table of zone) next.get(table.id)!.owner = owner;
        load.set(owner, (load.get(owner) ?? 0) + zone.length);
      }
    }

    if (roster.backup_enabled) {
      const zones = zonesOf(tables);
      const zoneMains = zones.map(
        (zone) => new Set(zone.map((table) => next.get(table.id)!.owner).filter(Boolean)),
      );
      const everyone = roster.staff.filter((m) => m.present).map((m) => m.id);
      zones.forEach((zone, index) => {
        const own = zoneMains[index];
        const previous = zones.length > 1 ? zones[(index - 1 + zones.length) % zones.length] : [];
        const outside =
          previous.map((table) => next.get(table.id)!.owner).find((p) => p && !own.has(p)) ??
          everyone.find((person) => !own.has(person)) ??
          null;
        const ownList = [...own] as string[];
        for (const table of zone) {
          const value = next.get(table.id)!;
          if (!value.owner) {
            value.backup = null;
            continue;
          }
          if (value.backup && !own.has(value.backup) && value.backup !== value.owner) continue;
          const neighbour =
            ownList.length > 1
              ? ownList[(ownList.indexOf(value.owner) - 1 + ownList.length) % ownList.length]
              : null;
          value.backup = outside ?? neighbour;
        }
      });
    } else {
      for (const value of next.values()) value.backup = null;
    }

    const changes = tables.flatMap((table) =>
      setTableStaff(db, table, next.get(table.id)!, {
        action: 'plan_applied',
        actorUserId,
        businessDate,
        mode: `plan:${plan.letter}`,
      }),
    );
    const numbers = new Map(
      (db.prepare('SELECT id, number FROM tables').all() as { id: string; number: string }[]).map(
        (row) => [row.id, String(row.number)],
      ),
    );
    const names = (ids: string[]) => ids.map((tableId) => numbers.get(tableId) ?? tableId);
    const userName = db.prepare('SELECT name FROM users WHERE id = ?');
    return {
      plan_id: id,
      changes,
      absent: [...absent].map((userId) => ({
        id: userId,
        name: (userName.get(userId) as { name: string } | undefined)?.name ?? userId,
      })),
      filled_tables: plan.auto_assign === 1 ? [] : names(filled),
      activated_tables: names(activated),
      deactivated_tables: names(deactivated),
      busy_tables: names(busy),
    };
  })();
}
