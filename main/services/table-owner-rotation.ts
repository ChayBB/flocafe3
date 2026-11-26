import { randomUUID } from 'crypto';
import { getDatabase, now } from '../db';
import { GUEST_USER_ID } from '../lib/guest-order';
import { currentBusinessDate } from './attendance';

type Db = ReturnType<typeof getDatabase>;

export const TABLE_OWNER_ASSIGNMENT_MODES = [
  'manual',
  'staff_managed',
  'rotate_daily',
  'shuffle_interval',
] as const;
export type TableOwnerAssignmentMode = (typeof TABLE_OWNER_ASSIGNMENT_MODES)[number];
type AutomaticMode = Extract<TableOwnerAssignmentMode, 'rotate_daily' | 'shuffle_interval'>;

function isAutomaticMode(mode: TableOwnerAssignmentMode): mode is AutomaticMode {
  return mode === 'rotate_daily' || mode === 'shuffle_interval';
}

export const SHUFFLE_DAYS_MIN = 1;
export const SHUFFLE_DAYS_MAX = 365;
const DEFAULT_SHUFFLE_DAYS = 7;
const CHECK_INTERVAL_MS = 60_000;

const MODE_KEY = 'table_owner_assignment_mode';
const SHUFFLE_DAYS_KEY = 'table_owner_shuffle_days';
const LAST_RUN_KEY = 'table_owner_assignment_last_run';
const BACKUP_ENABLED_KEY = 'table_backup_enabled';
const REZONE_SKIP_KEY = 'table_rezone_skip';
export const REZONE_SKIP_MAX_LENGTH = 500;

export interface TableOwnerAssignmentSettings {
  mode: TableOwnerAssignmentMode;
  shuffle_days: number;
  last_run: string | null;
  backup_enabled: boolean;
}

export interface TableOwnerAssignmentRun {
  ran: boolean;
  business_date: string;
  changes: TableAssignmentChange[];
}

export interface TableAssignmentChange {
  table_id: string;
  kind: 'owner' | 'backup';
  previous_user_id: string | null;
  next_user_id: string | null;
}

export interface TableStaffRosterMember {
  id: string;
  name: string;
  role: string;
  part_time: boolean;
  present: boolean;
  tables: { id: string; name: string }[];
  backup_tables: { id: string; name: string }[];
}

export interface TableStaffRosterTable {
  id: string;
  name: string;
  floor: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  backup_user_id: string | null;
}

export interface TableStaffRoster {
  business_date: string;
  staff: TableStaffRosterMember[];
  tables: TableStaffRosterTable[];
  table_count: number;
  table_count_default: number;
  table_count_custom: boolean;
  backup_enabled: boolean;
  rezone_skip: string;
}

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

function isMode(value: unknown): value is TableOwnerAssignmentMode {
  return (TABLE_OWNER_ASSIGNMENT_MODES as readonly unknown[]).includes(value);
}

export function isValidShuffleDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SHUFFLE_DAYS_MIN &&
    value <= SHUFFLE_DAYS_MAX
  );
}

/** Backup tables are on unless the store turned them off; saved backups stay in place while off. */
export function isTableBackupEnabled(db: Db): boolean {
  return readSetting(db, BACKUP_ENABLED_KEY) !== '0';
}

export function readTableOwnerAssignmentSettings(db: Db): TableOwnerAssignmentSettings {
  const mode = readSetting(db, MODE_KEY);
  const days = Number(readSetting(db, SHUFFLE_DAYS_KEY));
  return {
    mode: isMode(mode) ? mode : 'manual',
    shuffle_days: isValidShuffleDays(days) ? days : DEFAULT_SHUFFLE_DAYS,
    last_run: readSetting(db, LAST_RUN_KEY),
    backup_enabled: isTableBackupEnabled(db),
  };
}

function recordAudit(
  db: Db,
  entry: {
    action: string;
    tableId?: string | null;
    floor?: string | null;
    previousUserId?: string | null;
    nextUserId?: string | null;
    actorUserId?: string | null;
    businessDate: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO table_owner_audit
       (action, table_id, floor, previous_user_id, next_user_id, actor_user_id, business_date,
        details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.action,
    entry.tableId ?? null,
    entry.floor ?? null,
    entry.previousUserId ?? null,
    entry.nextUserId ?? null,
    entry.actorUserId ?? null,
    entry.businessDate,
    entry.details ? JSON.stringify(entry.details) : null,
    now(),
  );
}

const collator = new Intl.Collator('en', { numeric: true });

/** Active staff the owner assignment can pick, in a stable order. */
export function assignableStaff(
  db: Db,
): { id: string; name: string; role: string; part_time: number }[] {
  return db
    .prepare(
      'SELECT id, name, role, part_time FROM users WHERE is_active = 1 AND id != ? ORDER BY name COLLATE NOCASE, id',
    )
    .all(GUEST_USER_ID) as { id: string; name: string; role: string; part_time: number }[];
}

export interface ActiveTable {
  id: string;
  number: string;
  floor: string | null;
  owner_user_id: string | null;
  backup_user_id: string | null;
}

export function activeTablesInOrder(db: Db): ActiveTable[] {
  const rows = db
    .prepare(
      'SELECT id, number, floor, owner_user_id, backup_user_id FROM tables WHERE is_active = 1',
    )
    .all() as ActiveTable[];
  return rows.sort(
    (a, b) =>
      collator.compare(a.floor ?? '', b.floor ?? '') ||
      collator.compare(String(a.number), String(b.number)),
  );
}

/** Staff without a saved answer for the day count as present, so a new day starts with everyone in. */
export function readTableStaffRoster(
  db: Db,
  businessDate = currentBusinessDate(db),
): TableStaffRoster {
  const saved = new Map(
    (
      db
        .prepare('SELECT user_id, present FROM table_staff_attendance WHERE business_date = ?')
        .all(businessDate) as { user_id: string; present: number }[]
    ).map((row) => [row.user_id, row.present === 1]),
  );
  const tables = activeTablesInOrder(db);
  const defaultCount = tables.length;
  const day = db
    .prepare('SELECT table_count FROM table_service_days WHERE business_date = ?')
    .get(businessDate) as { table_count: number } | undefined;
  const staff = assignableStaff(db);
  const names = new Map(staff.map((member) => [member.id, member.name]));
  const shortTable = (table: ActiveTable) => ({ id: table.id, name: String(table.number) });
  const backupEnabled = isTableBackupEnabled(db);
  const backupOf = (table: ActiveTable) => (backupEnabled ? table.backup_user_id : null);
  return {
    business_date: businessDate,
    staff: staff.map(({ part_time, ...member }) => ({
      ...member,
      part_time: part_time === 1,
      present: saved.get(member.id) ?? true,
      tables: tables.filter((table) => table.owner_user_id === member.id).map(shortTable),
      backup_tables: tables.filter((table) => backupOf(table) === member.id).map(shortTable),
    })),
    tables: tables.map((table) => ({
      id: table.id,
      name: String(table.number),
      floor: table.floor,
      owner_user_id: table.owner_user_id,
      owner_name: table.owner_user_id ? (names.get(table.owner_user_id) ?? null) : null,
      backup_user_id: backupOf(table),
    })),
    table_count: day ? Math.min(day.table_count, defaultCount) : defaultCount,
    table_count_default: defaultCount,
    table_count_custom: Boolean(day),
    backup_enabled: backupEnabled,
    rezone_skip: readSetting(db, REZONE_SKIP_KEY) ?? '',
  };
}

/** Saves the tables a manager typed as not in use ("26, 12-13"), left out when re-zoning. */
export function saveRezoneSkip(db: Db, value: string): void {
  writeSetting(db, REZONE_SKIP_KEY, value);
}

export type RosterValidation =
  | { ok: true; presentIds: Set<string>; tableCount: number | null }
  | { ok: false; code: string; error: string };

export function validateTableStaffRoster(db: Db, body: unknown): RosterValidation {
  const input = (body ?? {}) as { present_user_ids?: unknown; table_count?: unknown };
  const ids = input.present_user_ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return {
      ok: false,
      code: 'ROSTER_STAFF_INVALID',
      error: 'present_user_ids must be a list of staff ids',
    };
  }
  const known = new Set(assignableStaff(db).map((member) => member.id));
  if (ids.some((id) => !known.has(id))) {
    return {
      ok: false,
      code: 'ROSTER_STAFF_UNKNOWN',
      error: 'Staff member was not found or is inactive',
    };
  }
  const tableCount = input.table_count ?? null;
  const activeCount = activeTablesInOrder(db).length;
  if (
    tableCount !== null &&
    !(
      typeof tableCount === 'number' &&
      Number.isInteger(tableCount) &&
      tableCount >= 1 &&
      tableCount <= activeCount
    )
  ) {
    return {
      ok: false,
      code: 'ROSTER_TABLE_COUNT_INVALID',
      error: `table_count must be a whole number from 1 to ${activeCount}, or null`,
    };
  }
  return {
    ok: true,
    presentIds: new Set(ids as string[]),
    tableCount: tableCount as number | null,
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The first `table_count` active tables, in zone then table order, are cut into one contiguous run
 * per staff member (see zoneRuns). Rotation shifts who takes which run by one every business day;
 * shuffle draws a fresh order per interval. Backups come from the neighbouring zone's staff.
 */
function plannedOwners(
  db: Db,
  businessDate: string,
  mode: AutomaticMode,
  shuffleSeed: string,
): Map<string, { owner: string | null; backup: string | null }> | null {
  const roster = readTableStaffRoster(db, businessDate);
  const staff = roster.staff.filter((member) => member.present).map((member) => member.id);
  if (staff.length === 0) return null;
  let order: string[];
  if (mode === 'rotate_daily') {
    const offset = Math.floor(Date.parse(`${businessDate}T00:00:00Z`) / 86_400_000) % staff.length;
    order = staff.map((_, index) => staff[(index + offset) % staff.length]);
  } else {
    const random = seededRandom(shuffleSeed);
    order = [...staff];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const tables = activeTablesInOrder(db);
  const plan = new Map<string, { owner: string | null; backup: string | null }>(
    tables.map((table) => [table.id, { owner: null, backup: null }]),
  );
  const groups = zoneRuns(tables.slice(0, roster.table_count), order.length);
  let next = 0;
  const owned = groups.map((group) => group.map((run) => ({ run, owner: order[next++] })));
  const spare = order[next] ?? null;
  owned.forEach((group, index) => {
    const previous = owned[(index - 1 + owned.length) % owned.length];
    group.forEach(({ run, owner }, position) => {
      let backup: string | null = null;
      if (roster.backup_enabled && owned.length > 1) {
        backup = previous[position % previous.length].owner;
      } else if (roster.backup_enabled && group.length > 1) {
        backup = group[(position - 1 + group.length) % group.length].owner;
      } else if (roster.backup_enabled) {
        backup = spare;
      }
      for (const table of run) plan.set(table.id, { owner, backup });
    });
  });
  return plan;
}

function splitEvenly<T>(items: T[], parts: number): T[][] {
  const base = Math.floor(items.length / parts);
  const extra = items.length % parts;
  const runs: T[][] = [];
  let cursor = 0;
  for (let index = 0; index < parts; index += 1) {
    const size = base + (index >= parts - extra ? 1 : 0);
    runs.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return runs.filter((run) => run.length > 0);
}

/**
 * Cuts the served tables into one run per staff member, grouped so that backups come from another
 * group. With at least as many staff as zones, every zone gets one person before any zone gets a
 * second (extra staff go to the zones with the most tables per person). With fewer staff than
 * zones, each person takes whole neighbouring zones, balanced by table count, and no zone is split.
 */
export function zoneRuns(served: ActiveTable[], staffCount: number): ActiveTable[][][] {
  const zones: ActiveTable[][] = [];
  for (const table of served) {
    const last = zones[zones.length - 1];
    if (last && (last[0].floor ?? '').trim() === (table.floor ?? '').trim()) last.push(table);
    else zones.push([table]);
  }
  if (zones.length === 0) return [];
  if (staffCount >= zones.length) {
    const people = zones.map(() => 1);
    for (let spare = staffCount - zones.length; spare > 0; spare -= 1) {
      let best = -1;
      zones.forEach((zone, index) => {
        if (people[index] >= zone.length) return;
        if (best < 0 || zone.length / people[index] > zones[best].length / people[best]) {
          best = index;
        }
      });
      if (best < 0) break;
      people[best] += 1;
    }
    return zones.map((zone, index) => splitEvenly(zone, people[index]));
  }
  const total = served.length;
  const groups: ActiveTable[][][] = [];
  let zoneIndex = 0;
  let taken = 0;
  for (let person = 0; person < staffCount; person += 1) {
    const run: ActiveTable[] = [];
    const target = (total * (person + 1)) / staffCount;
    const mustLeave = staffCount - person - 1;
    while (zoneIndex < zones.length - mustLeave) {
      const zone = zones[zoneIndex];
      const overshoot = taken + zone.length - target;
      if (run.length > 0 && overshoot > target - taken) break;
      run.push(...zone);
      taken += zone.length;
      zoneIndex += 1;
      if (taken >= target) break;
    }
    groups.push([run]);
  }
  return groups;
}

export function setTableStaff(
  db: Db,
  table: {
    id: string;
    floor: string | null;
    owner_user_id: string | null;
    backup_user_id: string | null;
  },
  next: { owner: string | null; backup: string | null },
  audit: { action: string; actorUserId: string | null; businessDate: string; mode?: string },
): TableAssignmentChange[] {
  const changes: TableAssignmentChange[] = [];
  const fields = [
    {
      kind: 'owner' as const,
      column: 'owner_user_id',
      before: table.owner_user_id,
      after: next.owner,
    },
    {
      kind: 'backup' as const,
      column: 'backup_user_id',
      before: table.backup_user_id,
      after: next.backup,
    },
  ];
  for (const field of fields) {
    if (field.before === field.after) continue;
    db.prepare(`UPDATE tables SET ${field.column} = ?, updated_at = ? WHERE id = ?`).run(
      field.after,
      now(),
      table.id,
    );
    changes.push({
      table_id: table.id,
      kind: field.kind,
      previous_user_id: field.before,
      next_user_id: field.after,
    });
    recordAudit(db, {
      action: audit.action,
      tableId: table.id,
      floor: table.floor,
      previousUserId: field.before,
      nextUserId: field.after,
      actorUserId: audit.actorUserId,
      businessDate: audit.businessDate,
      details: { kind: field.kind, ...(audit.mode ? { mode: audit.mode } : {}) },
    });
  }
  return changes;
}

function applyAssignment(
  db: Db,
  businessDate: string,
  settings: TableOwnerAssignmentSettings,
  audit: { action: string; actorUserId: string | null },
): TableAssignmentChange[] {
  if (!isAutomaticMode(settings.mode)) return [];
  const plan = plannedOwners(db, businessDate, settings.mode, settings.last_run ?? businessDate);
  if (!plan) return [];
  return activeTablesInOrder(db).flatMap((table) =>
    setTableStaff(db, table, plan.get(table.id) ?? { owner: null, backup: null }, {
      ...audit,
      businessDate,
      mode: settings.mode,
    }),
  );
}

export type StaffTablesValidation =
  | { ok: true; userId: string; tableIds: string[]; kind: 'owner' | 'backup' }
  | { ok: false; code: string; error: string };

export function validateStaffTables(db: Db, body: unknown): StaffTablesValidation {
  const input = (body ?? {}) as { user_id?: unknown; table_ids?: unknown; kind?: unknown };
  if (input.kind !== 'owner' && input.kind !== 'backup') {
    return { ok: false, code: 'STAFF_TABLES_KIND_INVALID', error: 'kind must be owner or backup' };
  }
  if (input.kind === 'backup' && !isTableBackupEnabled(db)) {
    return { ok: false, code: 'TABLE_BACKUP_DISABLED', error: 'Backup tables are turned off' };
  }
  if (
    typeof input.user_id !== 'string' ||
    !assignableStaff(db).some((member) => member.id === input.user_id)
  ) {
    return {
      ok: false,
      code: 'ROSTER_STAFF_UNKNOWN',
      error: 'Staff member was not found or is inactive',
    };
  }
  const ids = input.table_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
    return {
      ok: false,
      code: 'STAFF_TABLES_INVALID',
      error: 'table_ids must be a non-empty list of table ids',
    };
  }
  const active = new Map(activeTablesInOrder(db).map((table) => [table.id, table]));
  if (ids.some((id) => !active.has(id))) {
    return { ok: false, code: 'TABLE_NOT_FOUND', error: 'Table not found or inactive' };
  }
  if (
    input.kind === 'backup' &&
    ids.some((id) => active.get(id)?.owner_user_id === input.user_id)
  ) {
    return {
      ok: false,
      code: 'BACKUP_IS_OWNER',
      error: 'A staff member cannot back up a table they already look after',
    };
  }
  return {
    ok: true,
    userId: input.user_id,
    tableIds: [...new Set(ids as string[])],
    kind: input.kind,
  };
}

/** A manager hands extra tables to one person without redoing everyone; taking a table as owner clears them as its backup. */
export function assignStaffTables(
  db: Db,
  input: { userId: string; tableIds: string[]; kind: 'owner' | 'backup' },
  actorUserId: string,
): TableAssignmentChange[] {
  const businessDate = currentBusinessDate(db);
  const wanted = new Set(input.tableIds);
  return db.transaction(() =>
    activeTablesInOrder(db)
      .filter((table) => wanted.has(table.id))
      .flatMap((table) =>
        setTableStaff(
          db,
          table,
          input.kind === 'owner'
            ? {
                owner: input.userId,
                backup: table.backup_user_id === input.userId ? null : table.backup_user_id,
              }
            : { owner: table.owner_user_id, backup: input.userId },
          { action: 'manual_assign', actorUserId, businessDate },
        ),
      ),
  )();
}

export type StaffTablesEditValidation =
  | { ok: true; userId: string; ownIds: Set<string>; backupIds: Set<string> }
  | { ok: false; code: string; error: string };

export function validateStaffTablesEdit(db: Db, body: unknown): StaffTablesEditValidation {
  const input = (body ?? {}) as {
    user_id?: unknown;
    own_table_ids?: unknown;
    backup_table_ids?: unknown;
  };
  if (
    typeof input.user_id !== 'string' ||
    !assignableStaff(db).some((member) => member.id === input.user_id)
  ) {
    return {
      ok: false,
      code: 'ROSTER_STAFF_UNKNOWN',
      error: 'Staff member was not found or is inactive',
    };
  }
  const isIdList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (!isIdList(input.own_table_ids) || !isIdList(input.backup_table_ids)) {
    return {
      ok: false,
      code: 'STAFF_TABLES_INVALID',
      error: 'own_table_ids and backup_table_ids must be lists of table ids',
    };
  }
  const ownIds = new Set(input.own_table_ids);
  const backupIds = new Set(input.backup_table_ids);
  if (backupIds.size > 0 && !isTableBackupEnabled(db)) {
    return { ok: false, code: 'TABLE_BACKUP_DISABLED', error: 'Backup tables are turned off' };
  }
  const active = new Set(activeTablesInOrder(db).map((table) => table.id));
  if ([...ownIds, ...backupIds].some((id) => !active.has(id))) {
    return { ok: false, code: 'TABLE_NOT_FOUND', error: 'Table not found or inactive' };
  }
  if ([...backupIds].some((id) => ownIds.has(id))) {
    return {
      ok: false,
      code: 'BACKUP_IS_OWNER',
      error: 'A staff member cannot back up a table they already look after',
    };
  }
  return { ok: true, userId: input.user_id, ownIds, backupIds };
}

/** Sets exactly which tables one person looks after and backs up; tables they drop are left unassigned. */
export function editStaffTables(
  db: Db,
  input: { userId: string; ownIds: Set<string>; backupIds: Set<string> },
  actorUserId: string,
): TableAssignmentChange[] {
  const businessDate = currentBusinessDate(db);
  const backupEnabled = isTableBackupEnabled(db);
  return db.transaction(() =>
    activeTablesInOrder(db).flatMap((table) => {
      const owner = input.ownIds.has(table.id)
        ? input.userId
        : table.owner_user_id === input.userId
          ? null
          : table.owner_user_id;
      const backup = input.backupIds.has(table.id)
        ? input.userId
        : (backupEnabled && table.backup_user_id === input.userId) || owner === table.backup_user_id
          ? null
          : table.backup_user_id;
      return setTableStaff(
        db,
        table,
        { owner, backup },
        {
          action: 'manual_edit',
          actorUserId,
          businessDate,
        },
      );
    }),
  )();
}

export type OwnTablesClaim =
  | { ok: true; changes: TableAssignmentChange[] }
  | { ok: false; status: number; code: string; error: string };

/**
 * In staff-managed mode a signed-in staff member sets which tables they look after, and, when the
 * store uses backup tables and the request names them, which tables they back up. They can take free
 * tables and drop their own, but never take or clear a table or backup slot another person holds.
 */
export function claimOwnTables(db: Db, userId: string, body: unknown): OwnTablesClaim {
  if (readTableOwnerAssignmentSettings(db).mode !== 'staff_managed') {
    return {
      ok: false,
      status: 403,
      code: 'STAFF_MANAGED_MODE_OFF',
      error: 'Staff can choose their own tables only when the store lets staff manage tables',
    };
  }
  if (!assignableStaff(db).some((member) => member.id === userId)) {
    return {
      ok: false,
      status: 403,
      code: 'ROSTER_STAFF_UNKNOWN',
      error: 'Staff member was not found or is inactive',
    };
  }
  const ids = (body as { table_ids?: unknown } | null)?.table_ids;
  const backupIds = (body as { backup_table_ids?: unknown } | null)?.backup_table_ids;
  const isIdList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (!isIdList(ids) || (backupIds !== undefined && !isIdList(backupIds))) {
    return {
      ok: false,
      status: 400,
      code: 'STAFF_TABLES_INVALID',
      error: 'table_ids and backup_table_ids must be lists of table ids',
    };
  }
  const wanted = new Set(ids);
  const wantedBackup = backupIds === undefined ? null : new Set(backupIds);
  if (wantedBackup?.size && !isTableBackupEnabled(db)) {
    return {
      ok: false,
      status: 403,
      code: 'TABLE_BACKUP_DISABLED',
      error: 'The store does not use backup tables',
    };
  }
  if (wantedBackup && [...wantedBackup].some((id) => wanted.has(id))) {
    return {
      ok: false,
      status: 400,
      code: 'STAFF_TABLES_OVERLAP',
      error: 'A table cannot be both your table and your backup table',
    };
  }
  const tables = activeTablesInOrder(db);
  const active = new Map(tables.map((table) => [table.id, table]));
  if ([...wanted, ...(wantedBackup ?? [])].some((id) => !active.has(id))) {
    return {
      ok: false,
      status: 400,
      code: 'TABLE_NOT_FOUND',
      error: 'Table not found or inactive',
    };
  }
  if (
    [...wanted].some((id) => {
      const owner = active.get(id)?.owner_user_id;
      return owner != null && owner !== userId;
    })
  ) {
    return {
      ok: false,
      status: 409,
      code: 'TABLE_OWNED_BY_OTHER',
      error: 'Another staff member already looks after this table',
    };
  }
  if (
    wantedBackup &&
    [...wantedBackup].some((id) => {
      const backup = active.get(id)?.backup_user_id;
      return backup != null && backup !== userId;
    })
  ) {
    return {
      ok: false,
      status: 409,
      code: 'TABLE_BACKUP_TAKEN',
      error: 'Another staff member already backs up this table',
    };
  }
  const businessDate = currentBusinessDate(db);
  const changes = db.transaction(() =>
    tables.flatMap((table) => {
      const mine = table.owner_user_id === userId;
      const owner = wanted.has(table.id) ? userId : mine ? null : table.owner_user_id;
      let backup = table.backup_user_id;
      if (wantedBackup)
        backup = wantedBackup.has(table.id) ? userId : backup === userId ? null : backup;
      if (owner === userId && backup === userId) backup = null;
      if (owner === table.owner_user_id && backup === table.backup_user_id) return [];
      return setTableStaff(
        db,
        table,
        { owner, backup },
        {
          action: 'staff_claim',
          actorUserId: userId,
          businessDate,
        },
      );
    }),
  )();
  return { ok: true, changes };
}

/**
 * Switching to an automatic mode runs today's assignment at once and counts it as today's run.
 * Turning backup tables on or off in an automatic mode reruns today's plan so backups follow at once.
 */
export function updateTableOwnerAssignmentSettings(
  db: Db,
  input: { mode: TableOwnerAssignmentMode; shuffle_days: number; backup_enabled?: boolean },
  actorUserId: string,
): TableOwnerAssignmentSettings & { changes: number } {
  const before = readTableOwnerAssignmentSettings(db);
  const businessDate = currentBusinessDate(db);
  const backupEnabled = input.backup_enabled ?? before.backup_enabled;
  const changes = db.transaction(() => {
    writeSetting(db, MODE_KEY, input.mode);
    writeSetting(db, SHUFFLE_DAYS_KEY, String(input.shuffle_days));
    if (input.mode !== before.mode) writeSetting(db, LAST_RUN_KEY, businessDate);
    if (input.mode !== before.mode || input.shuffle_days !== before.shuffle_days) {
      recordAudit(db, {
        action: 'mode_changed',
        actorUserId,
        businessDate,
        details: { from: before.mode, to: input.mode, shuffle_days: input.shuffle_days },
      });
    }
    if (backupEnabled !== before.backup_enabled) {
      writeSetting(db, BACKUP_ENABLED_KEY, backupEnabled ? '1' : '0');
      recordAudit(db, {
        action: 'backup_toggled',
        actorUserId,
        businessDate,
        details: { enabled: backupEnabled },
      });
    }
    if (input.mode === before.mode && backupEnabled === before.backup_enabled) return [];
    return applyAssignment(db, businessDate, readTableOwnerAssignmentSettings(db), {
      action: input.mode,
      actorUserId,
    });
  })();
  return { ...readTableOwnerAssignmentSettings(db), changes: changes.length };
}

/** A manager's one-off shuffle: today's present staff get a fresh random split, whatever the mode. */
export function shuffleTableStaffNow(
  db: Db,
  actorUserId: string,
  businessDate = currentBusinessDate(db),
): { roster: TableStaffRoster; changes: TableAssignmentChange[] } | null {
  const plan = plannedOwners(
    db,
    businessDate,
    'shuffle_interval',
    `${businessDate}:${randomUUID()}`,
  );
  if (!plan) return null;
  const changes = db.transaction(() =>
    activeTablesInOrder(db).flatMap((table) =>
      setTableStaff(db, table, plan.get(table.id) ?? { owner: null, backup: null }, {
        action: 'shuffle_now',
        actorUserId,
        businessDate,
      }),
    ),
  )();
  return { roster: readTableStaffRoster(db, businessDate), changes };
}

/** Saves today's attendance and service table count; automatic modes reassign straight away. */
export function saveTableStaffRoster(
  db: Db,
  input: { presentIds: Set<string>; tableCount: number | null },
  actorUserId: string,
  businessDate = currentBusinessDate(db),
): { roster: TableStaffRoster; changes: TableOwnerAssignmentRun['changes'] } {
  const changes = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO table_staff_attendance (business_date, user_id, present, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(business_date, user_id) DO UPDATE SET
         present = excluded.present, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    );
    for (const member of assignableStaff(db)) {
      upsert.run(
        businessDate,
        member.id,
        input.presentIds.has(member.id) ? 1 : 0,
        actorUserId,
        now(),
      );
    }
    if (input.tableCount === null) {
      db.prepare('DELETE FROM table_service_days WHERE business_date = ?').run(businessDate);
    } else {
      db.prepare(
        `INSERT INTO table_service_days (business_date, table_count, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(business_date) DO UPDATE SET
           table_count = excluded.table_count, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(businessDate, input.tableCount, actorUserId, now());
    }
    return applyAssignment(db, businessDate, readTableOwnerAssignmentSettings(db), {
      action: 'roster_changed',
      actorUserId,
    });
  })();
  return { roster: readTableStaffRoster(db, businessDate), changes };
}

/** Runs at most once per business day; a missed boundary is caught up once, not once per missed day. */
export function runTableOwnerAssignmentIfDue(
  db: Db,
  options: { businessDate?: string } = {},
): TableOwnerAssignmentRun {
  const settings = readTableOwnerAssignmentSettings(db);
  const businessDate = options.businessDate ?? currentBusinessDate(db);
  const idle: TableOwnerAssignmentRun = { ran: false, business_date: businessDate, changes: [] };
  if (!isAutomaticMode(settings.mode)) return idle;
  if (!settings.last_run) {
    writeSetting(db, LAST_RUN_KEY, businessDate);
    return idle;
  }
  const elapsed = daysBetween(settings.last_run, businessDate);
  const due = settings.mode === 'rotate_daily' ? elapsed >= 1 : elapsed >= settings.shuffle_days;
  if (!due) return idle;

  return db.transaction((): TableOwnerAssignmentRun => {
    writeSetting(db, LAST_RUN_KEY, businessDate);
    const changes = applyAssignment(
      db,
      businessDate,
      { ...settings, last_run: businessDate },
      { action: settings.mode, actorUserId: null },
    );
    return { ran: true, business_date: businessDate, changes };
  })();
}

let checkHandle: ReturnType<typeof setInterval> | null = null;

function checkSafely(): void {
  try {
    runTableOwnerAssignmentIfDue(getDatabase());
  } catch (error) {
    console.error('[TableOwnerRotation] Assignment check failed:', error);
  }
}

export function startTableOwnerRotation(intervalMs: number = CHECK_INTERVAL_MS): void {
  stopTableOwnerRotation();
  checkSafely();
  checkHandle = setInterval(checkSafely, intervalMs);
  checkHandle.unref?.();
}

export function stopTableOwnerRotation(): void {
  if (checkHandle) {
    clearInterval(checkHandle);
    checkHandle = null;
  }
}
