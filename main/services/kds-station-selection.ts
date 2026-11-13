import {
  getDatabase,
  getUserKdsStationIds,
  hasUserKdsStationAssignments,
  getKdsStationRoutingScope,
} from '../db';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import { parseCategoryIds } from '../routes/auth';

export function selectedKdsStationIds(userId: string, selected: string): string[] | null {
  const db = getDatabase();
  const assigned = getUserKdsStationIds(db, userId);
  const configured = hasUserKdsStationAssignments(db, userId);
  if (!assigned || configured === null || (configured && assigned.length === 0)) return null;
  if (!selected) return assigned;
  // A display left on a station that was removed or unassigned falls back to the user's own scope.
  if (assigned.length > 0 && !assigned.includes(selected)) return assigned;
  if (!db.prepare('SELECT 1 FROM kitchen_stations WHERE id = ? AND is_active = 1').get(selected))
    return assigned;
  return [selected];
}

export function selectableKdsStations(userId: string): { id: string; name: string }[] {
  const db = getDatabase();
  const assigned = selectedKdsStationIds(userId, '');
  if (!assigned) return [];
  const user = db
    .prepare('SELECT role, category_ids FROM users WHERE id = ? AND is_active = 1')
    .get(userId) as { role: string; category_ids: string | null } | undefined;
  if (!user) return [];
  const categories = hasRole(user.role, ROLE_ACCESS.ownerManager)
    ? []
    : parseCategoryIds(user.category_ids);
  const stations = db
    .prepare('SELECT id, name FROM kitchen_stations WHERE is_active = 1 ORDER BY sort_order, name')
    .all() as { id: string; name: string }[];
  return stations.filter((station) => {
    if (assigned.length > 0 && !assigned.includes(station.id)) return false;
    const scope = getKdsStationRoutingScope(db, [station.id], categories);
    if (!scope) return false;
    const allowed = scope.categoryIdsByStation[station.id];
    return allowed === null || (allowed?.length ?? 0) > 0;
  });
}
