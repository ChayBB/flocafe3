import { Router, Request, Response } from 'express';
import {
  attachEffectiveAddons,
  getDatabase,
  isGuestQrOrderingEnabled,
  isServerAppEnabled,
  now,
  parseItemJson,
  parseRowJson,
  recordOrderAudit,
  withTxn,
} from '../db';
import * as QRCode from 'qrcode';
import { getLocalIP } from '../server-state';
import { getServerAppPort } from '../server-app-state';
import { guestSessionToken, guestStickerCode, readGuestQrNetwork } from '../lib/guest-qr';
import {
  closeGuestTableSession,
  openGuestTableSession,
  recordGuestQrAudit,
  type GuestTableSession,
} from '../lib/guest-table-session';
import { randomUUID } from 'crypto';
import { hasPermission, requirePermission } from '../services/authorization';
import { notifyKdsUpdate } from '../services/kds';
import { cloudSync } from '../services/cloud-sync';
import { GUEST_USER_ID } from '../lib/guest-order';
import { printTableQrSlip, WINDOWS_DOCUMENT_PRINTER_MARKER } from '../printers/thermal';
import { resolveTenantReceiptLanguages } from './printers';
import { storeTimezone } from '../services/attendance';
import { getHttpRequestSignal } from '../shutdown';
import { TERMINAL_ITEM_STATUSES } from '../../shared/order-item-status';

const router = Router();

const ACTIVE_ORDER_STATUS_SQL = "status NOT IN ('completed', 'cancelled')";

function activeOrderForTable(
  db: ReturnType<typeof getDatabase>,
  tableId: string,
  orderId?: number | string,
  options: { includeItems?: boolean } = {},
) {
  const whereOrder = orderId ? ' AND id = ?' : '';
  const params = orderId ? [tableId, orderId] : [tableId];
  const order = parseRowJson(
    db
      .prepare(`
    SELECT * FROM orders
    WHERE table_id = ? AND ${ACTIVE_ORDER_STATUS_SQL}${whereOrder}
    ORDER BY created_at DESC LIMIT 1
  `)
      .get(...params) as any,
  );
  if (!order) return order;

  const hydratedOrder = options.includeItems
    ? {
        ...order,
        items: attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(order.id)
            .map(parseItemJson) as Array<{ id: number; [key: string]: unknown }>,
        ),
      }
    : order;
  if (!hydratedOrder.customer_id) return hydratedOrder;

  const customer = db
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(hydratedOrder.customer_id);
  return { ...hydratedOrder, customer: customer || null };
}

/** Kitchen progress of an open order's menu lines: still waiting or cooking, ready, served, and served lines staff confirmed at the table. */
function kitchenCounts(db: ReturnType<typeof getDatabase>, orderId: number) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
         COALESCE(SUM(CASE WHEN status IN ('served', 'completed') THEN 1 ELSE 0 END), 0) AS served,
         COALESCE(SUM(CASE WHEN status IN ('served', 'completed') AND served_confirmed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS served_confirmed,
         COUNT(*) AS total
       FROM order_items
       WHERE order_id = ? AND status NOT IN (${TERMINAL_ITEM_STATUSES.map(() => '?').join(',')})`,
    )
    .get(orderId, ...TERMINAL_ITEM_STATUSES) as {
    ready: number;
    served: number;
    served_confirmed: number;
    total: number;
  };
  return {
    waiting: row.total - row.ready - row.served,
    ready: row.ready,
    served: row.served,
    served_confirmed: row.served_confirmed,
  };
}

function reservationCustomerShape(
  db: ReturnType<typeof getDatabase>,
  table: { status: string; reservation_customer_id?: string | null },
) {
  const reservationCustomer =
    table.status === 'reserved' && table.reservation_customer_id
      ? (db
          .prepare('SELECT name, phone FROM customers WHERE id = ?')
          .get(table.reservation_customer_id) as { name: string; phone: string | null } | undefined)
      : undefined;
  return {
    reservation_customer_id:
      table.status === 'reserved' ? (table.reservation_customer_id ?? null) : null,
    reservation_customer_name: reservationCustomer?.name ?? null,
    reservation_customer_phone: reservationCustomer?.phone ?? null,
  };
}

function tableShape(
  db: ReturnType<typeof getDatabase>,
  table: any,
  activeOrder?: any,
  includeReservationCustomer = true,
) {
  const currentOrder = activeOrder || null;
  const owner = table.owner_user_id
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(table.owner_user_id) as
        | { name: string }
        | undefined)
    : undefined;
  const shownOrder =
    currentOrder && !includeReservationCustomer
      ? { ...currentOrder, customer_id: null, customer: null }
      : currentOrder;
  const visibleCurrentOrder = shownOrder
    ? { ...shownOrder, kitchen_counts: kitchenCounts(db, shownOrder.id) }
    : shownOrder;
  return {
    ...table,
    name: table.number,
    owner_name: owner?.name ?? null,
    ...(includeReservationCustomer
      ? reservationCustomerShape(db, table)
      : {
          reservation_customer_id: null,
          reservation_customer_name: null,
          reservation_customer_phone: null,
        }),
    activeOrder: visibleCurrentOrder,
    current_order: visibleCurrentOrder,
    seated_at: visibleCurrentOrder?.created_at ?? null,
  };
}

/** Normalize a customer-facing table name without coercing objects or nullish values. */
function normalizeTableNumber(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

/** Normalize optional floor/section labels and flag non-string payloads as invalid. */
function normalizeOptionalTableLabel(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() || null;
}

/** Accept only positive integer number primitives or their non-empty string representation. */
function normalizeTableCapacity(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

router.get('/', requirePermission('tables.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM tables WHERE 1=1';
    const params: any[] = [];

    if (req.query.status) {
      query += ' AND status = ?';
      params.push(req.query.status);
    }
    if (req.query.floor) {
      query += ' AND floor = ?';
      params.push(req.query.floor);
    }
    if (req.query.section) {
      query += ' AND section = ?';
      params.push(req.query.section);
    }
    if (req.query.kitchen_station_id) {
      query += ' AND kitchen_station_id = ?';
      params.push(req.query.kitchen_station_id);
    }
    if (req.query.active === 'true' || req.query.active === '1') {
      query += ' AND is_active = 1';
    }

    query += ' ORDER BY number';

    const rows = db.prepare(query).all(...params);
    const userId = (req as Request & { user?: { userId?: string } }).user?.userId || '';
    const includeReservationCustomer = hasPermission(userId, 'customers.view');
    const includeOrderItems =
      (req.query.include_items === '1' || req.query.include_items === 'true') &&
      hasPermission(userId, 'orders.read');
    const activeOrdersByTableId = new Map<string, any>();
    for (const t of rows as any[]) {
      const activeOrder = activeOrderForTable(db, t.id, undefined, { includeItems: false });
      if (activeOrder) activeOrdersByTableId.set(t.id, activeOrder);
    }
    if (includeOrderItems && activeOrdersByTableId.size > 0) {
      const orderIds = Array.from(
        new Set(Array.from(activeOrdersByTableId.values()).map((order) => order.id)),
      );
      const placeholders = orderIds.map(() => '?').join(', ');
      const hydratedItems = attachEffectiveAddons(
        db,
        db
          .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`)
          .all(...orderIds)
          .map(parseItemJson) as Array<{ id: number; order_id: number; [key: string]: unknown }>,
      );
      const itemsByOrderId = new Map<number, Array<Record<string, unknown>>>();
      for (const item of hydratedItems) {
        const list = itemsByOrderId.get(Number(item.order_id)) || [];
        list.push(item);
        itemsByOrderId.set(Number(item.order_id), list);
      }
      for (const [tableId, activeOrder] of activeOrdersByTableId.entries()) {
        activeOrdersByTableId.set(tableId, {
          ...activeOrder,
          items: itemsByOrderId.get(Number(activeOrder.id)) || [],
        });
      }
    }
    // Normalize: frontend expects `name`, schema column is `number`
    const tables = rows.map((t: any) =>
      tableShape(db, t, activeOrdersByTableId.get(t.id) || null, includeReservationCustomer),
    );
    res.json({ tables });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** A staff member owns one zone (floor) only. Returns the other zone they already own, if any. */
function ownerZoneConflict(
  db: ReturnType<typeof getDatabase>,
  ownerId: string,
  tableId: string,
  floor: string | null,
): { floor: string } | null {
  const target = floor ?? '';
  const others = db
    .prepare('SELECT floor FROM tables WHERE owner_user_id = ? AND id != ?')
    .all(ownerId, tableId) as { floor: string | null }[];
  const conflict = others.find((row) => (row.floor ?? '') !== target);
  return conflict ? { floor: conflict.floor ?? '' } : null;
}

// Staff who can be assigned as a table's owner. Owners are informational and never gate orders.
router.get(
  '/owner-candidates',
  requirePermission('tables.manage'),
  (_req: Request, res: Response) => {
    const db = getDatabase();
    const rows = db
      .prepare(
        'SELECT id, name, role FROM users WHERE is_active = 1 AND id != ? ORDER BY name COLLATE NOCASE',
      )
      .all(GUEST_USER_ID) as { id: string; name: string; role: string }[];
    const owned = db
      .prepare('SELECT owner_user_id AS id, floor FROM tables WHERE owner_user_id IS NOT NULL')
      .all() as { id: string; floor: string | null }[];
    const zonesByStaff = new Map<string, Set<string>>();
    for (const row of owned) {
      const zones = zonesByStaff.get(row.id) ?? new Set<string>();
      zones.add(row.floor ?? '');
      zonesByStaff.set(row.id, zones);
    }
    res.json({
      staff: rows.map((member) => ({ ...member, zones: [...(zonesByStaff.get(member.id) ?? [])] })),
    });
  },
);

// Sets (or clears) the single owner of every active table in one zone (floor).
const MAX_BATCH_TABLES = 100;

// Creates every table of a new zone at once; optionally gives the zone an owner.
router.post('/batch', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rawTables = req.body?.tables;
    if (
      !Array.isArray(rawTables) ||
      rawTables.length === 0 ||
      rawTables.length > MAX_BATCH_TABLES
    ) {
      return res
        .status(400)
        .json({ error: `tables must contain between 1 and ${MAX_BATCH_TABLES} entries` });
    }
    const floor = normalizeOptionalTableLabel(req.body?.floor);
    if (floor === undefined) {
      return res
        .status(400)
        .json({ code: 'TABLE_LOCATION_INVALID', error: 'Floor must be a text value' });
    }

    const rows: { number: string; capacity: number; x: number | null; y: number | null }[] = [];
    const seen = new Set<string>();
    for (const entry of rawTables) {
      const number = normalizeTableNumber(entry?.number ?? entry?.name);
      if (!number) {
        return res
          .status(400)
          .json({ code: 'TABLE_NAME_REQUIRED', error: 'Table number is required' });
      }
      if (seen.has(number.toLowerCase())) {
        return res.status(400).json({
          code: 'TABLE_NAME_DUPLICATE',
          error: `Table ${number} is listed twice`,
          table: number,
        });
      }
      seen.add(number.toLowerCase());
      const blank =
        entry?.capacity === undefined || entry?.capacity === null || entry?.capacity === '';
      const capacity = blank ? 4 : normalizeTableCapacity(entry.capacity);
      if (capacity === null) {
        return res.status(400).json({
          code: 'TABLE_CAPACITY_INVALID',
          error: 'Capacity must be a positive whole number',
          table: number,
        });
      }
      const x = normalizePositionCoord(entry?.position_x);
      const y = normalizePositionCoord(entry?.position_y);
      if (x === undefined || y === undefined) {
        return res
          .status(400)
          .json({ error: 'Coordinates must be numbers between 0 and 100, or null' });
      }
      rows.push({ number, capacity, x, y });
    }

    for (const row of rows) {
      const existing = db
        .prepare('SELECT is_active FROM tables WHERE number = ?')
        .get(row.number) as { is_active: number } | undefined;
      if (existing) {
        return res.status(400).json({
          code: existing.is_active === 0 ? 'TABLE_INACTIVE_DUPLICATE' : 'TABLE_NAME_DUPLICATE',
          error: `Table ${row.number} already exists`,
          table: row.number,
        });
      }
    }

    const rawOwner = req.body?.owner_user_id;
    let ownerId: string | null = null;
    if (rawOwner !== null && rawOwner !== undefined && rawOwner !== '') {
      if (typeof rawOwner !== 'string') {
        return res.status(400).json({ error: 'owner_user_id must be a string' });
      }
      const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(rawOwner);
      if (!user)
        return res.status(400).json({ error: 'Staff member was not found or is inactive' });
      const owned = db
        .prepare(
          "SELECT 1 FROM tables WHERE owner_user_id = ? AND COALESCE(floor, '') != ? LIMIT 1",
        )
        .get(rawOwner, floor ?? '');
      if (owned && req.body?.move !== true) {
        return res.status(409).json({
          error: 'This staff member already owns another zone',
          code: 'owner_in_other_zone',
        });
      }
      ownerId = rawOwner;
    }

    const created = withTxn(() => {
      if (ownerId) {
        db.prepare(
          "UPDATE tables SET owner_user_id = NULL, updated_at = ? WHERE owner_user_id = ? AND COALESCE(floor, '') != ?",
        ).run(now(), ownerId, floor ?? '');
      }
      const insert = db.prepare(
        'INSERT INTO tables (id, number, capacity, floor, position_x, position_y, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      return rows.map((row) => {
        const id = `tbl-${randomUUID().slice(0, 8)}`;
        insert.run(id, row.number, row.capacity, floor, row.x, row.y, ownerId, now(), now());
        return db.prepare('SELECT * FROM tables WHERE id = ?').get(id);
      });
    });
    res.status(201).json({
      tables: created.map((table) => tableShape(db, table as any, null)),
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function guestQrBase(): { baseUrl: string; public: boolean } {
  // A public address lets customers order over mobile data; otherwise the QR only works on the shop network.
  const { publicBaseUrl } = readGuestQrNetwork();
  return {
    baseUrl: publicBaseUrl
      ? `${publicBaseUrl}/server-standalone/`
      : `http://${getLocalIP()}:${getServerAppPort()}/server-standalone/`,
    public: Boolean(publicBaseUrl),
  };
}

export function guestSessionUrl(baseUrl: string, session: GuestTableSession): string {
  return `${baseUrl}?table=${encodeURIComponent(session.table_id)}&t=${guestSessionToken(session.id)}`;
}

function stickerUrl(baseUrl: string, table: { id: string; guest_sticker_version: number }): string {
  return `${baseUrl}?table=${encodeURIComponent(table.id)}&s=${guestStickerCode(table.id, table.guest_sticker_version)}`;
}

// The permanent sticker QR for each table: phones scanning it join the table's open session, or ask
// staff to open the table. `renew` retires a table's printed sticker, for one that was copied or lost.
router.post(
  '/guest-stickers',
  requirePermission('tables.manage'),
  async (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const renew: string[] = Array.isArray(req.body?.renew)
        ? req.body.renew.filter((id: unknown) => typeof id === 'string')
        : [];
      if (renew.length) {
        const bump = db.prepare(
          'UPDATE tables SET guest_sticker_version = guest_sticker_version + 1 WHERE id = ?',
        );
        const actor = (req as any).user?.userId ?? null;
        db.transaction(() => {
          for (const id of renew) {
            if (bump.run(id).changes) {
              recordGuestQrAudit(db, { tableId: id, actor, action: 'sticker_replaced' });
            }
          }
        })();
      }
      const rows = db
        .prepare(
          `SELECT id, number, guest_sticker_version, floor FROM tables
           WHERE is_active = 1 ORDER BY floor, number`,
        )
        .all() as {
        id: string;
        number: string;
        guest_sticker_version: number;
        floor: string | null;
      }[];
      const base = guestQrBase();
      const stickers = await Promise.all(
        rows.map(async (row) => {
          const url = stickerUrl(base.baseUrl, row);
          return {
            id: row.id,
            name: row.number,
            floor: row.floor,
            url,
            data_url: await QRCode.toDataURL(url, {
              errorCorrectionLevel: 'M',
              margin: 1,
              width: 320,
            }),
          };
        }),
      );
      res.json({
        stickers,
        public: base.public,
        server_app_enabled: isServerAppEnabled(),
        guest_ordering_enabled: isGuestQrOrderingEnabled(),
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

function activeTable(id: unknown): { id: string; number: string } | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return getDatabase()
    .prepare('SELECT id, number FROM tables WHERE id = ? AND is_active = 1')
    .get(id) as { id: string; number: string } | undefined;
}

// Staff hand a seated party the table's QR; `renew` gives a new code and retires the old one.
router.post(
  '/:id/guest-session',
  requirePermission('orders.create'),
  async (req: Request, res: Response) => {
    try {
      const table = activeTable(req.params.id);
      if (!table) return res.status(404).json({ error: 'Table not found' });
      const session = openGuestTableSession(
        getDatabase(),
        table.id,
        (req as any).user?.userId ?? null,
        { renew: req.body?.renew === true },
      );
      const base = guestQrBase();
      const url = guestSessionUrl(base.baseUrl, session);
      res.json({
        table: { id: table.id, name: table.number },
        session: { created_at: session.created_at, expires_at: session.expires_at },
        url,
        data_url: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 0, width: 320 }),
        store_timezone: storeTimezone(getDatabase()),
        public: base.public,
        server_app_enabled: isServerAppEnabled(),
        guest_ordering_enabled: isGuestQrOrderingEnabled(),
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Prints the session's QR on the default receipt printer; a document printer or none answers with a
// code so the page prints it through the browser instead.
router.post(
  '/:id/guest-session/print',
  requirePermission('orders.create'),
  requirePermission('printing.execute'),
  async (req: Request, res: Response) => {
    try {
      const table = activeTable(req.params.id);
      if (!table) return res.status(404).json({ error: 'Table not found' });
      const db = getDatabase();
      const printer = db
        .prepare(
          "SELECT * FROM printers WHERE connection_type != 'webusb' ORDER BY is_default DESC, name LIMIT 1",
        )
        .get();
      if (!printer) {
        return res.status(400).json({ error: 'No printer configured', code: 'no_printer' });
      }
      const session = openGuestTableSession(db, table.id, (req as any).user?.userId ?? null);
      const language = resolveTenantReceiptLanguages(db).primary;
      const result = await printTableQrSlip(
        {
          tableName: table.number,
          url: guestSessionUrl(guestQrBase().baseUrl, session),
          validUntil: formatStoreTime(db, session.expires_at, language),
        },
        printer as any,
        getHttpRequestSignal(req),
        language,
      );
      if (result.ok) return res.json({ success: true });
      return res.status(502).json({
        error: result.detail || 'Print failed. Check printer connection.',
        ...(result.detail?.includes(WINDOWS_DOCUMENT_PRINTER_MARKER)
          ? { code: 'document_printer' }
          : {}),
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

function formatStoreTime(
  db: ReturnType<typeof getDatabase>,
  sqlTimestamp: string,
  language: string,
): string {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
    timeZone: storeTimezone(db),
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(`${sqlTimestamp.replace(' ', 'T')}Z`));
}

router.delete(
  '/:id/guest-session',
  requirePermission('orders.create'),
  (req: Request, res: Response) => {
    try {
      const table = activeTable(req.params.id);
      if (!table) return res.status(404).json({ error: 'Table not found' });
      res.json({
        closed: closeGuestTableSession(getDatabase(), table.id, (req as any).user?.userId ?? null),
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Who opened, unlocked, renewed or ended the table's QR, newest first. A session that ran to the
// daily reset shows as `expired` at its reset time, and "cancel all table QR codes" shows on every table.
router.get(
  '/:id/guest-qr-audit',
  requirePermission('tables.manage'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const table = db.prepare('SELECT id FROM tables WHERE id = ?').get(req.params.id) as
        | { id: string }
        | undefined;
      if (!table) return res.status(404).json({ error: 'Table not found' });
      const events = db
        .prepare(
          `SELECT * FROM (
             SELECT a.id AS seq, a.action, a.session_id, a.created_at, a.actor_user_id, u.name AS actor_name
             FROM guest_qr_audit a LEFT JOIN users u ON u.id = a.actor_user_id
             WHERE a.table_id = ? OR a.table_id IS NULL
             UNION ALL
             SELECT 0, 'expired', s.id, s.expires_at, NULL, NULL
             FROM guest_table_sessions s
             WHERE s.table_id = ? AND s.expires_at <= ?
               AND (s.closed_at IS NULL OR s.closed_reason = 'expired')
           ) ORDER BY created_at DESC, seq DESC LIMIT 100`,
        )
        .all(table.id, table.id, now()) as { seq: number }[];
      res.json({
        events: events.map(({ seq: _seq, ...event }) => event),
        store_timezone: storeTimezone(db),
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.put('/zone-owner', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rawFloor = req.body?.floor;
    if (rawFloor !== null && rawFloor !== undefined && typeof rawFloor !== 'string') {
      return res.status(400).json({ error: 'floor must be a string' });
    }
    const floor = (rawFloor ?? '').trim();
    const zoneTables = db
      .prepare("SELECT id FROM tables WHERE COALESCE(floor, '') = ? AND is_active = 1")
      .all(floor) as { id: string }[];
    if (zoneTables.length === 0) return res.status(404).json({ error: 'Zone not found' });

    const raw = req.body?.user_id;
    let ownerId: string | null = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (typeof raw !== 'string')
        return res.status(400).json({ error: 'user_id must be a string' });
      const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(raw);
      if (!user)
        return res.status(400).json({ error: 'Staff member was not found or is inactive' });
      const owned = db
        .prepare(
          "SELECT 1 FROM tables WHERE owner_user_id = ? AND COALESCE(floor, '') != ? LIMIT 1",
        )
        .get(raw, floor);
      if (owned && req.body?.move !== true) {
        return res.status(409).json({
          error: 'This staff member already owns another zone',
          code: 'owner_in_other_zone',
        });
      }
      ownerId = raw;
    }

    withTxn(() => {
      if (ownerId) {
        db.prepare(
          "UPDATE tables SET owner_user_id = NULL, updated_at = ? WHERE owner_user_id = ? AND COALESCE(floor, '') != ?",
        ).run(now(), ownerId, floor);
      }
      db.prepare(
        "UPDATE tables SET owner_user_id = ?, updated_at = ? WHERE COALESCE(floor, '') = ? AND is_active = 1",
      ).run(ownerId, now(), floor);
    });
    res.json({ floor, user_id: ownerId, updated: zoneTables.length });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/owner', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const table = db.prepare('SELECT id, floor FROM tables WHERE id = ?').get(req.params.id) as
      | { id: string; floor: string | null }
      | undefined;
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const raw = req.body?.user_id;
    let ownerId: string | null = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (typeof raw !== 'string')
        return res.status(400).json({ error: 'user_id must be a string' });
      const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(raw);
      if (!user)
        return res.status(400).json({ error: 'Staff member was not found or is inactive' });
      const conflict = ownerZoneConflict(db, raw, table.id, table.floor);
      if (conflict && req.body?.move === true) {
        // Daily rotation: the staff member leaves their previous zone and takes this one.
        db.prepare(
          "UPDATE tables SET owner_user_id = NULL, updated_at = ? WHERE owner_user_id = ? AND id != ? AND COALESCE(floor, '') != ?",
        ).run(now(), raw, table.id, table.floor ?? '');
      } else if (conflict) {
        return res.status(409).json({
          error: 'This staff member already owns another zone',
          code: 'owner_in_other_zone',
          zone: conflict.floor,
        });
      }
      ownerId = raw;
    }
    db.prepare('UPDATE tables SET owner_user_id = ?, updated_at = ? WHERE id = ?').run(
      ownerId,
      now(),
      req.params.id,
    );
    const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    res.json({
      table: tableShape(db, updated as any, activeOrderForTable(db, req.params.id as string)),
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', requirePermission('tables.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const userId = (req as Request & { user?: { userId?: string } }).user?.userId || '';
    const activeOrder = activeOrderForTable(db, req.params.id as string, undefined, {
      includeItems: hasPermission(userId, 'orders.read'),
    });
    const includeReservationCustomer = hasPermission(userId, 'customers.view');

    // Normalize: frontend expects `name`, schema column is `number`
    res.json({ table: tableShape(db, table as any, activeOrder, includeReservationCustomer) });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rename a floor across every table. Renaming to an existing floor name merges
// every row from `:name` into the target in one UPDATE. Issue #646.
router.patch('/floors/:name', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const oldName = String(req.params.name || '');
    if (!oldName) {
      return res.status(400).json({ code: 'FLOOR_NAME_REQUIRED', error: 'Floor name is required' });
    }
    const newName = normalizeOptionalTableLabel(req.body?.newName);
    if (newName === undefined || newName === null || !newName) {
      return res.status(400).json({ code: 'FLOOR_NAME_REQUIRED', error: 'Floor name is required' });
    }
    if (newName === oldName) {
      return res.json({ floor: newName, affected: 0 });
    }

    const db = getDatabase();
    const result = db
      .prepare(`
      UPDATE tables SET floor = ?, updated_at = ?
      WHERE floor = ?
    `)
      .run(newName, now(), oldName);

    res.json({ floor: newName, previousFloor: oldName, affected: result.changes });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Floor rename failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove a floor label from every table that uses it; tables stay and fall
// back into the Unassigned bucket. Issue #646.
router.delete(
  '/floors/:name',
  requirePermission('tables.manage'),
  (req: Request, res: Response) => {
    try {
      const name = String(req.params.name || '');
      if (!name) {
        return res
          .status(400)
          .json({ code: 'FLOOR_NAME_REQUIRED', error: 'Floor name is required' });
      }

      const db = getDatabase();
      const result = db
        .prepare(`
      UPDATE tables SET floor = NULL, position_x = NULL, position_y = NULL, updated_at = ?
      WHERE floor = ?
    `)
        .run(now(), name);

      res.json({ floor: null, removedFloor: name, affected: result.changes });
    } catch (error: any) {
      res.locals.postHogError = error;
      console.error('[API] Floor delete failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post('/', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    // Accept `number` (schema column) or `name` (legacy frontend field)
    const { number, name, capacity, floor, section, position_x, position_y, kitchen_station_id } =
      req.body;
    const tableNumber = normalizeTableNumber(number ?? name);

    if (!tableNumber) {
      return res
        .status(400)
        .json({ code: 'TABLE_NAME_REQUIRED', error: 'Table number is required' });
    }

    const normalizedCapacity = capacity === undefined ? 4 : normalizeTableCapacity(capacity);
    if (normalizedCapacity === null) {
      return res.status(400).json({
        code: 'TABLE_CAPACITY_INVALID',
        error: 'Capacity must be a positive whole number',
      });
    }

    const normalizedFloor = normalizeOptionalTableLabel(floor);
    const normalizedSection = normalizeOptionalTableLabel(section);
    if (normalizedFloor === undefined || normalizedSection === undefined) {
      return res
        .status(400)
        .json({ code: 'TABLE_LOCATION_INVALID', error: 'Floor and section must be text values' });
    }
    const normalizedX = normalizePositionCoord(position_x);
    const normalizedY = normalizePositionCoord(position_y);
    if (normalizedX === undefined || normalizedY === undefined) {
      return res
        .status(400)
        .json({ error: 'Coordinates must be numbers between 0 and 100, or null' });
    }

    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM tables WHERE number = ?').get(tableNumber) as any;
    if (existing) {
      if (existing.is_active === 0) {
        return res.status(400).json({
          code: 'TABLE_INACTIVE_DUPLICATE',
          error: `Table ${tableNumber} already exists but is deactivated. Please reactivate it from the list.`,
        });
      } else {
        return res
          .status(400)
          .json({ code: 'TABLE_NAME_DUPLICATE', error: 'Table number already exists' });
      }
    }

    const tableId = `tbl-${randomUUID().slice(0, 8)}`;
    const result = db
      .prepare(`
      INSERT INTO tables (id, number, capacity, floor, section, position_x, position_y, kitchen_station_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        tableId,
        tableNumber,
        normalizedCapacity,
        normalizedFloor,
        normalizedSection,
        normalizedX,
        normalizedY,
        kitchen_station_id || null,
        now(),
        now(),
      );

    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
    res.status(201).json({ table });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Canvas-percentage coordinate: null/undefined clears, otherwise a finite
// 0–100 number. Returns undefined for anything else so callers can reject it.
function normalizePositionCoord(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

router.patch('/positions', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const raw = req.body?.positions;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'Positions array is required' });
    }

    const updates: Array<{
      id: string;
      hasPosition: boolean;
      position_x: number | null;
      position_y: number | null;
      orientation: string | null;
    }> = [];
    for (const item of raw) {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) {
        return res.status(400).json({ error: 'Invalid table ID in positions payload' });
      }
      const hasPosition = 'position_x' in item || 'position_y' in item;
      const x = normalizePositionCoord(item.position_x);
      const y = normalizePositionCoord(item.position_y);
      if (x === undefined || y === undefined) {
        return res
          .status(400)
          .json({ error: 'Coordinates must be numbers between 0 and 100, or null' });
      }
      const orientation = item.orientation ?? null;
      if (orientation !== null && orientation !== 'horizontal' && orientation !== 'vertical') {
        return res.status(400).json({ error: 'orientation must be horizontal or vertical' });
      }
      updates.push({
        id: item.id.trim(),
        hasPosition,
        position_x: x,
        position_y: y,
        orientation,
      });
    }

    const db = getDatabase();
    if (updates.length > 0) {
      const rows = db
        .prepare(`SELECT id FROM tables WHERE id IN (${updates.map(() => '?').join(',')})`)
        .all(...updates.map((u) => u.id)) as Array<{ id: string }>;
      const found = new Set(rows.map((r) => r.id));
      const missing = updates.find((u) => !found.has(u.id));
      if (missing) {
        return res.status(404).json({ error: `Table not found: ${missing.id}` });
      }
    }
    withTxn(() => {
      // A rotation-only entry carries no coordinates and must leave the position alone.
      const stmt = db.prepare(`
        UPDATE tables SET
          position_x = CASE WHEN ? = 1 THEN ? ELSE position_x END,
          position_y = CASE WHEN ? = 1 THEN ? ELSE position_y END,
          orientation = COALESCE(?, orientation),
          updated_at = ?
        WHERE id = ?
      `);
      const currentTime = now();
      for (const u of updates) {
        stmt.run(
          u.hasPosition ? 1 : 0,
          u.position_x,
          u.hasPosition ? 1 : 0,
          u.position_y,
          u.orientation,
          currentTime,
          u.id,
        );
      }
    });

    res.json({ success: true, count: updates.length });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const { number, name, capacity, floor, section, position_x, position_y, kitchen_station_id } =
      req.body;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(req.body, key);
    const hasTableNumber = has('number') || has('name');
    const tableNumber = hasTableNumber
      ? normalizeTableNumber(has('number') ? number : name)
      : undefined;
    const db = getDatabase();

    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id) as any;
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    if (hasTableNumber && !tableNumber) {
      return res
        .status(400)
        .json({ code: 'TABLE_NAME_REQUIRED', error: 'Table number is required' });
    }

    const normalizedCapacity = has('capacity') ? normalizeTableCapacity(capacity) : table.capacity;
    if (normalizedCapacity === null) {
      return res.status(400).json({
        code: 'TABLE_CAPACITY_INVALID',
        error: 'Capacity must be a positive whole number',
      });
    }

    const normalizedFloor = has('floor') ? normalizeOptionalTableLabel(floor) : table.floor;
    const normalizedSection = has('section') ? normalizeOptionalTableLabel(section) : table.section;
    const normalizedX = has('position_x') ? normalizePositionCoord(position_x) : table.position_x;
    const normalizedY = has('position_y') ? normalizePositionCoord(position_y) : table.position_y;
    if (normalizedX === undefined || normalizedY === undefined) {
      return res
        .status(400)
        .json({ error: 'Coordinates must be numbers between 0 and 100, or null' });
    }
    if (normalizedFloor === undefined || normalizedSection === undefined) {
      return res
        .status(400)
        .json({ code: 'TABLE_LOCATION_INVALID', error: 'Floor and section must be text values' });
    }

    if (table.owner_user_id && (normalizedFloor ?? null) !== (table.floor ?? null)) {
      const conflict = ownerZoneConflict(db, table.owner_user_id, table.id, normalizedFloor);
      if (conflict) {
        return res.status(409).json({
          error: 'The table owner already owns another zone; change the owner first',
          code: 'owner_in_other_zone',
          zone: conflict.floor,
        });
      }
    }

    if (hasTableNumber) {
      const existing = db
        .prepare('SELECT * FROM tables WHERE number = ? AND id != ?')
        .get(tableNumber, req.params.id);
      if (existing) {
        return res
          .status(400)
          .json({ code: 'TABLE_NAME_DUPLICATE', error: 'Table number already exists' });
      }
    }

    db.prepare(`
      UPDATE tables SET
        number = ?,
        capacity = ?,
        floor = ?,
        section = ?,
        position_x = ?,
        position_y = ?,
        kitchen_station_id = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      hasTableNumber ? tableNumber : table.number,
      normalizedCapacity,
      normalizedFloor,
      normalizedSection,
      normalizedX,
      normalizedY,
      has('kitchen_station_id') ? kitchen_station_id : table.kitchen_station_id,
      now(),
      req.params.id,
    );

    const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    res.json({
      table: tableShape(db, updated as any, activeOrderForTable(db, req.params.id as string)),
    });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/:id/deactivate',
  requirePermission('tables.manage'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id) as any;
      if (!table) {
        return res.status(404).json({ error: 'Table not found' });
      }
      if (table.is_active === 0) {
        return res.status(400).json({ error: 'Already deactivated' });
      }

      const activeOrder = db
        .prepare(`
      SELECT * FROM orders WHERE table_id = ? AND ${ACTIVE_ORDER_STATUS_SQL}
    `)
        .get(req.params.id);
      if (activeOrder) {
        return res.status(400).json({ error: 'Cannot deactivate table with active orders' });
      }

      db.prepare('UPDATE tables SET is_active = 0, updated_at = ? WHERE id = ?').run(
        now(),
        req.params.id,
      );
      const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
      res.json({ table: tableShape(db, updated as any) });
    } catch (error: any) {
      res.locals.postHogError = error;
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/:id/reactivate',
  requirePermission('tables.manage'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id) as any;
      if (!table) {
        return res.status(404).json({ error: 'Table not found' });
      }
      if (table.is_active === 1) {
        return res.status(400).json({ error: 'Already active' });
      }

      db.prepare('UPDATE tables SET is_active = 1, updated_at = ? WHERE id = ?').run(
        now(),
        req.params.id,
      );
      const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
      res.json({ table: tableShape(db, updated as any) });
    } catch (error: any) {
      res.locals.postHogError = error;
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/:id/move-order',
  requirePermission('tables.orders.move'),
  (req: Request, res: Response) => {
    try {
      const sourceTableId = req.params.id as string;
      const { target_table_id, order_id } = req.body;

      if (!target_table_id) {
        return res.status(400).json({ error: 'target_table_id is required' });
      }
      if (target_table_id === sourceTableId) {
        return res.status(400).json({ error: 'Order is already on this table' });
      }

      const db = getDatabase();
      const moved = withTxn(() => {
        const sourceTable = db
          .prepare('SELECT * FROM tables WHERE id = ?')
          .get(sourceTableId) as any;
        if (!sourceTable) {
          const error: any = new Error('Source table not found');
          error.status = 404;
          throw error;
        }

        const targetTable = db
          .prepare('SELECT * FROM tables WHERE id = ?')
          .get(target_table_id) as any;
        if (!targetTable) {
          const error: any = new Error('Target table not found');
          error.status = 404;
          throw error;
        }
        if (!targetTable.is_active) {
          throw Object.assign(new Error('Target table is not active'), { status: 400 });
        }

        const order = activeOrderForTable(db, sourceTableId, order_id) as any;
        if (!order) {
          const error: any = new Error(
            order_id
              ? 'Active order not found on source table'
              : 'Source table has no active order',
          );
          error.status = 404;
          throw error;
        }

        const targetActiveOrder = activeOrderForTable(db, target_table_id) as any;
        if (targetActiveOrder) {
          const error: any = new Error('Target table already has an active order');
          error.status = 409;
          throw error;
        }

        const targetHeldOrder = db
          .prepare('SELECT id FROM held_orders WHERE table_id = ?')
          .get(target_table_id);
        const currentTargetTable = db
          .prepare('SELECT * FROM tables WHERE id = ?')
          .get(target_table_id) as { is_active?: number | boolean; status?: string } | undefined;
        if (!currentTargetTable) {
          throw Object.assign(new Error('Target table not found'), { status: 404 });
        }
        if (!currentTargetTable.is_active) {
          throw Object.assign(new Error('Target table is not active'), { status: 400 });
        }
        if (
          targetHeldOrder ||
          targetTable.status === 'held' ||
          currentTargetTable.status === 'held'
        ) {
          const error: any = new Error('Target table has a held order');
          error.status = 409;
          throw error;
        }
        if (targetTable.status === 'reserved' || currentTargetTable.status === 'reserved') {
          throw Object.assign(new Error('Target table is reserved'), { status: 409 });
        }

        const nowStr = now();
        db.prepare(
          'UPDATE orders SET table_id = ?, table_owner_user_id = (SELECT owner_user_id FROM tables WHERE id = ?), type = ?, updated_at = ? WHERE id = ?',
        ).run(target_table_id, target_table_id, order.type, nowStr, order.id);
        recordOrderAudit(db, {
          orderId: order.id,
          actorUserId: (req as Request & { user: { userId: string } }).user.userId,
          action: 'order_table_moved',
          details: { from_table: sourceTable.number, to_table_id: targetTable.id },
        });
        db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?").run(
          nowStr,
          sourceTableId,
        );
        db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ?").run(
          nowStr,
          target_table_id,
        );

        const updatedOrder = parseRowJson(
          db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id) as any,
        );
        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
        const updatedSource = db
          .prepare('SELECT * FROM tables WHERE id = ?')
          .get(sourceTableId) as any;
        const updatedTarget = db
          .prepare('SELECT * FROM tables WHERE id = ?')
          .get(target_table_id) as any;

        return {
          order: {
            ...updatedOrder,
            items,
            table: { ...updatedTarget, name: updatedTarget.number },
          },
          sourceTable: tableShape(db, updatedSource, activeOrderForTable(db, sourceTableId)),
          targetTable: tableShape(db, updatedTarget, activeOrderForTable(db, target_table_id)),
        };
      });

      cloudSync.recordOrderChanged(moved.order.id, 'order.table_moved');
      notifyKdsUpdate();

      res.json({
        order: moved.order,
        sourceTable: moved.sourceTable,
        targetTable: moved.targetTable,
      });
    } catch (error: any) {
      res.locals.postHogError = error;
      const statusCode = error.status || 500;
      console.error('[API] Table move failed:', error);
      res
        .status(statusCode)
        .json({ error: statusCode >= 500 ? 'Table move failed' : error.message });
    }
  },
);

router.patch('/:id/status', requirePermission('tables.manage'), (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const reservationCustomerId = req.body.reservation_customer_id;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['available', 'occupied', 'reserved', 'cleaning', 'held'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
    }
    if (status !== 'reserved' && reservationCustomerId != null) {
      return res
        .status(400)
        .json({ error: 'A reservation customer can only be set for a reserved table' });
    }

    let normalizedReservationCustomerId: string | null = null;
    if (status === 'reserved' && reservationCustomerId != null) {
      if (typeof reservationCustomerId !== 'string' || !reservationCustomerId.trim()) {
        return res
          .status(400)
          .json({ error: 'Reservation customer ID must be a non-empty string' });
      }
      normalizedReservationCustomerId = reservationCustomerId.trim();
    }

    const db = getDatabase();
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    if (normalizedReservationCustomerId) {
      const customer = db
        .prepare('SELECT id FROM customers WHERE id = ? AND is_active = 1')
        .get(normalizedReservationCustomerId);
      if (!customer) {
        return res.status(400).json({ error: 'Reservation customer was not found or is inactive' });
      }
    }

    if (status === 'reserved') {
      db.prepare(
        'UPDATE tables SET status = ?, reservation_customer_id = ?, updated_at = ? WHERE id = ?',
      ).run(status, normalizedReservationCustomerId, now(), req.params.id);
    } else {
      db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        now(),
        req.params.id,
      );
    }

    const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id) as {
      status: string;
      reservation_customer_id?: string | null;
      [key: string]: unknown;
    };
    res.json({ table: { ...updated, ...reservationCustomerShape(db, updated) } });
  } catch (error: any) {
    res.locals.postHogError = error;
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const tableRoutes = router;
