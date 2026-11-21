import type Database from 'better-sqlite3';
import { getKdsStationRoutingCategoryIds } from '../db';

function isDrinkGroup(name: string): boolean {
  return /บาร์\s*น้ำ|เครื่องดื่ม|\b(?:drinks?|beverages?)\b|^bar$/iu.test(name.trim());
}

function isIce(name: string): boolean {
  return /^น้ำแข็ง(?!ไส)|^ice(?:$|\s+(?:cubes?|bucket|cup|glass|bag|small|large)\b)/iu.test(
    name.trim(),
  );
}

/** Reorders bill lines only: food, then drinks from the dearest down, then ice; ties keep their order. */
export function sortBillItems<
  T extends {
    product_id?: string;
    product_name?: string;
    unit_price?: number | string | null;
    quantity?: number | string | null;
    total?: number | string | null;
  },
>(db: Database.Database, items: T[], stationId?: number | string | null): T[] {
  if (items.length < 2) return items;
  const stations = db
    .prepare('SELECT id, name FROM kitchen_stations WHERE is_active = 1')
    .all() as { id: number | string; name: string }[];
  const drinkStations = stations.filter((station) => isDrinkGroup(station.name));
  const tableDrinks = drinkStations.some((station) => String(station.id) === String(stationId));
  const drinkCategories = new Set(
    getKdsStationRoutingCategoryIds(
      db,
      drinkStations.map((station) => String(station.id)),
      [],
    ) ?? [],
  );
  const products = new Map<string, boolean>();
  const ids = [...new Set(items.map((item) => item.product_id).filter((id): id is string => !!id))];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const rows = db
      .prepare(`
      SELECT p.id, p.category_id, c.name AS category_name, parent.name AS parent_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN categories parent ON parent.id = c.parent_id
      WHERE p.id IN (${chunk.map(() => '?').join(',')})
    `)
      .all(...chunk) as {
      id: string;
      category_id: string;
      category_name: string | null;
      parent_name: string | null;
    }[];
    for (const row of rows) {
      products.set(
        row.id,
        drinkCategories.has(row.category_id) ||
          isDrinkGroup(row.category_name ?? '') ||
          isDrinkGroup(row.parent_name ?? ''),
      );
    }
  }
  const priority = (item: T) =>
    isIce(item.product_name ?? '') ? 2 : tableDrinks || products.get(item.product_id ?? '') ? 1 : 0;
  const unitPrice = (item: T) => {
    const unit = item.unit_price == null ? NaN : Number(item.unit_price);
    if (Number.isFinite(unit)) return unit;
    const total = Number(item.total);
    const quantity = Number(item.quantity);
    return Number.isFinite(total) && quantity > 0 ? total / quantity : 0;
  };
  return [...items].sort((a, b) => {
    const group = priority(a) - priority(b);
    if (group !== 0 || priority(a) !== 1) return group;
    return unitPrice(b) - unitPrice(a);
  });
}
