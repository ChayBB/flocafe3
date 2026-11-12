import type { NextFunction, Request, Response } from 'express';

/** Every table QR reads the same menu, so one catalog read serves all guests for a while. */
export const GUEST_MENU_TTL_MS = 30_000;

const CATALOG_WRITE_PATHS = [
  '/api/categories',
  '/api/products',
  '/api/addon-groups',
  '/api/menu-csv',
  '/api/tax-packs',
  '/api/db',
  '/api/db-tools',
];

let cached: { menu: unknown; expiresAt: number } | null = null;
let generation = 0;
let pending: { generation: number; menu: Promise<unknown> } | null = null;

export function invalidateGuestMenu(): void {
  generation += 1;
  cached = null;
}

/** The cached menu, or a fresh one from `load`; a load that a catalog edit overtook is not kept. */
export async function guestMenu<T>(
  load: () => Promise<T | null>,
  now = Date.now,
): Promise<T | null> {
  if (cached && cached.expiresAt > now()) return cached.menu as T;
  const startedAt = generation;
  if (pending?.generation === startedAt) return pending.menu as Promise<T | null>;
  const flight = { generation: startedAt, menu: Promise.resolve().then(load) };
  pending = flight;
  try {
    const menu = await flight.menu;
    if (menu !== null && startedAt === generation) {
      cached = { menu, expiresAt: now() + GUEST_MENU_TTL_MS };
    }
    return menu;
  } finally {
    if (pending === flight) pending = null;
  }
}

/** Drops the cached guest menu once a request that may change the catalog succeeds. */
export function invalidateGuestMenuOnCatalogWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestPath = req.path.toLowerCase();
  if (
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    CATALOG_WRITE_PATHS.some((p) => requestPath === p || requestPath.startsWith(`${p}/`))
  ) {
    res.once('finish', () => {
      if (res.statusCode < 400) invalidateGuestMenu();
    });
  }
  next();
}
