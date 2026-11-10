/**
 * Integrated Cloud QR Ordering connector: configuration, inbox durability, lifecycle, TLS trust
 * and order acceptance into an isolated POS with a simulated Cloud transport.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-cloud-connector.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-cloud-test-'));
let encryptionAvailable = true;
let isPackaged = true;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return {
      app: { isPackaged, getPath: () => tempRoot, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => encryptionAvailable,
        encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
        decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8'),
      },
    };
  return originalLoad.apply(this, arguments as never);
};

const inboxDir = path.join(tempRoot, 'qr-cloud');
process.env.FLO_QR_CLOUD_DIR = inboxDir;

const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const {
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const config = require('../main/services/qr-cloud/config');
const inbox = require('../main/services/qr-cloud/inbox');
const connector = require('../main/services/qr-cloud/connector');
const tls = require('../main/services/qr-cloud/tls');
const legacyImport = require('../main/services/qr-cloud/legacy-import');

const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIC4zCCAcugAwIBAgIIWAjUhkitXFUwDQYJKoZIhvcNAQELBQAwHzEdMBsGA1UEAxMURmxvQ2Fm
ZSBUZXN0IFJvb3QgQ0EwHhcNMjYxMTA3MDMxNTU4WhcNMzExMTA4MDMxNTU4WjAfMR0wGwYDVQQD
ExRGbG9DYWZlIFRlc3QgUm9vdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALm1
yydeuSEPX9pY1iOplNTRlUqmHFftt4aQENU/X8dbL7eGqLvnjWV0tHFP1vdrtuMuMovE5m0Ko1s7
Tw8GBld2kEduMReaQFuaj/AcBIESbsFX+h+llgB7b1/UowRdlOESlmiPpxLkVpk9bU8KYbJJv/46
AJE3Sdew3ONgFu5RO+b5k2Afq3nN+y0RlVSnvnunpxx5PJdABjqBHFKSlE+uAeOHrxXE2G6xDvR/
Q3a9FG+MR3KmnZgFPK3ZYi1tpW+4Fs0RgQJ0aWYtsPN5H2NpwiKMSdR2rtWuPiV4h+A9T3OluvgP
v7vrceRlf0pw4HRm1l0eNQrPJeEMWE/P9xUCAwEAAaMjMCEwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAKir7ATxMZQ4L1+xXhnV0kuOb6gY+MrK7JSR
FXSxiNZT1q16D9ZK7KiheYUiakjTh6lEp/0vmQoc6j5k5ZLmJNBT8yDSRq/hRBkg1ecD6+ARM/N+
n7IOQVnRbEUnpNXp98wTDeIQmT/Pm3JMQdpzv+JOzwyYNL+TT/HHS9frwRsWK6ZaapbzgbSbT2FL
2jam0oaC4esNwi0VApo0OztMyuafeq7DadM2VyDKrXjLBT53hmMHrk7cxLpOZsNl8WxuV8WLsma9
FQNib2lSM5vpA2n44qujIUPmcQM7ZnHDugLUIHCrxjC/LDxxZu+Al8Ff12V1RMK9HYhQThe/+MsW
YSM=
-----END CERTIFICATE-----`;

const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIICwTCCAamgAwIBAgIJALDHJWR6JiavMA0GCSqGSIb3DQEBCwUAMBcxFTATBgNVBAMTDGxlYWYu
ZXhhbXBsZTAeFw0yNjExMDcwMzE1NThaFw0zMTExMDgwMzE1NThaMBcxFTATBgNVBAMTDGxlYWYu
ZXhhbXBsZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALmaFNSrWVMXtY1MGO52+2M/
L9mZ5skMnfYLpNBf6+bsqSqFHicv2CKk/UrH0YKzNZ6vXXpT6Fy3F5TSGa52Sq0MwwWx1zVwTaSM
1C/MZWDEvcv0VTYiawBCiZ/zvnIrhS48y6M/xseF5flhRG6UuR0tA1xO0nmbY/H4A1SS1pPoremt
NOFmOBhkVYNnwkYi6Gpoyhfd/jTNCsT22ZPFvioFl1qc3ZbpBxrKT5y6cjdNIVLGF84L7RLqwxwt
F9M0lnmFzdb6RP2gF2xPz1vinBfri5hS7cQ5Fq9YHlEOBXRmJ84tT7QhFAiIBQgBOHfX5ksLnTj1
eMSWcaa93LDAOCkCAwEAAaMQMA4wDAYDVR0TAQH/BAIwADANBgkqhkiG9w0BAQsFAAOCAQEAAa9u
gd3AJ2quhgkD9eqD8koKTGcaSy3/faTEVf3rydYB7axQOGiVlzFZKt/KBHQON0SJjDDVUOxKVWlW
m+ILExXzavr9HddU15fwxRSVbk8QxT3dbGUq4BaWDR6TIUv5DBASadJvSOTUorPlHiOIm7kol5hk
yqvejXJQuOLCvtSWgi/n282adO63cXNeQYiH0alO6R0lvuHstkpHajcK8GMyGggeKl8x5Q+zYzNh
ddGxjmbWEC1YSAB3BsoY53EZm7nbYkVAGIY+LIJkwJ9r3PUND9MrHZ2hBjFKBUlLd3e1hHIBZ3xr
qRaPOMyRgltPX3IzzZax3jhUttW389FrLQ==
-----END CERTIFICATE-----`;

function expectThrow(fn: () => unknown, code: string, label: string) {
  try {
    fn();
  } catch (error: any) {
    assertEqualOrThrow(error?.code, code, `${label}: rejects with ${code}`);
    return;
  }
  throw new Error(`${label}: expected ${code} but nothing was thrown`);
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached in time');
}

async function verifyOrderAcceptance() {
  const assert = require('node:assert/strict');
  const express = require('express');
  const https = require('node:https');
  const jwt = require('jsonwebtoken');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { requireAuth } = require('../main/server');
  const { setServerPort } = require('../main/server-state');
  const { getJWTSecret } = require('../main/security/jwt-secret');
  const { orderRoutes } = require('../main/routes/orders');
  const { qrCloudRoutes } = require('../main/routes/qr-cloud');
  const db = getDatabase();
  require('../main/db').upsertSettings({
    country: 'TH',
    currency: 'THB',
    timezone: 'Asia/Bangkok',
  });
  const eventId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const actor = 'cloud-acceptance-owner';
  const staff = 'cloud-acceptance-server';
  const order = {
    order_id: orderId,
    table_name: 'Cloud fixture table',
    pos_table_id: 'cloud-table-a',
    table_session_current: true,
    created_at: new Date().toISOString(),
    total_satang: 7800,
    items: [
      {
        external_id: 'unknown',
        name: 'Cloud item',
        quantity: 2,
        unit_price_satang: 3900,
        note: '',
      },
    ],
  };
  db.prepare('INSERT INTO users (id, name, password, role) VALUES (?, ?, ?, ?)').run(
    actor,
    'Owner',
    'unused',
    'owner',
  );
  db.prepare('INSERT INTO users (id, name, password, role) VALUES (?, ?, ?, ?)').run(
    staff,
    'Server',
    'unused',
    'server',
  );
  db.prepare('INSERT INTO tables (id, number) VALUES (?, ?), (?, ?)').run(
    'cloud-table-a',
    'QA-A',
    'cloud-table-b',
    'QA-B',
  );
  db.prepare('INSERT INTO tables (id, number, is_active) VALUES (?, ?, 0)').run(
    'cloud-table-inactive',
    'QA-Inactive',
  );
  db.prepare('INSERT INTO products (id, name, price) VALUES (?, ?, ?)').run(
    'cloud-product',
    'POS fixture item',
    42,
  );
  config.updateConfig({ enabled: true });
  inbox.storeEvents([{ id: eventId, kind: 'order.created', payload: { order_id: orderId } }]);
  inbox.openInbox().exec('DROP TABLE order_acceptances; PRAGMA user_version = 1');
  inbox.closeInbox();
  assert.equal(inbox.openInbox().pragma('user_version', { simple: true }), 4);
  assert.equal(
    inbox.openInbox().prepare('SELECT status FROM inbox_events WHERE event_id = ?').get(eventId)
      .status,
    'received',
  );

  const app = express();
  app.use(express.json(), requireAuth);
  app.use('/api/qr-cloud', qrCloudRoutes);
  app.use('/api/orders', orderRoutes);
  let tickets = 0;
  app.post(
    '/api/printers/print-kot',
    (_req: unknown, res: { sendStatus: (status: number) => void }) => {
      tickets++;
      res.sendStatus(204);
    },
  );
  const server = app.listen(0, '127.0.0.1');
  const originalRequest = https.request;
  const outbound: string[] = [];
  let pageBody: unknown = order;
  const acknowledgements: { pos_receipt_id: string }[] = [];
  const kitchenReports: { order_id: string; statuses: string[] }[] = [];
  https.request = (
    options: { method: string; path: string; rejectUnauthorized: boolean },
    callback: (response: unknown) => void,
  ) => {
    assert.equal(options.rejectUnauthorized, true);
    outbound.push(`${options.method} ${options.path}`);
    const request = new EventEmitter();
    request.end = (body?: string) => {
      const response = new PassThrough();
      const ack = options.path.endsWith('/ack-receipt');
      const receipt = ack ? JSON.parse(body!) : null;
      const tableAction = options.path.endsWith('/table-qr') ? JSON.parse(body!) : null;
      if (options.path.endsWith('/order-status')) {
        kitchenReports.push(JSON.parse(body!));
        response.statusCode = 200;
        callback(response);
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (tableAction) {
        response.statusCode = 200;
        callback(response);
        response.end(
          JSON.stringify(
            tableAction.action === 'close'
              ? { closed: true }
              : {
                  url: 'https://order.example.test/#table=8a2db45c-4b1a-4392-b813-9d165c58f9d3',
                  expires_at: '2030-01-01T00:00:00Z',
                },
          ),
        );
        return;
      }
      if (receipt) acknowledgements.push(receipt);
      response.statusCode = ack && acknowledgements.length === 1 ? 503 : 200;
      callback(response);
      response.end(
        JSON.stringify(ack ? { ok: true, pos_receipt_id: receipt.pos_receipt_id } : pageBody),
      );
    };
    return request;
  };
  try {
    const { once } = require('node:events');
    await once(server, 'listening');
    const { port } = server.address();
    setServerPort(port);
    const route = `http://127.0.0.1:${port}/api/qr-cloud/inbox/orders/${eventId}`;
    const headersFor = (userId: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt.sign({ userId }, getJWTSecret(), { expiresIn: '1m' })}`,
    });
    const headers = headersFor(actor);
    const stickers = `http://127.0.0.1:${port}/api/qr-cloud/table-qr`;
    const listed = await fetch(stickers, { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (await listed.json()).tables.filter((table: { id: string }) =>
        table.id.startsWith('cloud-table-'),
      ),
      [
        { id: 'cloud-table-a', number: 'QA-A', is_active: true },
        { id: 'cloud-table-b', number: 'QA-B', is_active: true },
        { id: 'cloud-table-inactive', number: 'QA-Inactive', is_active: false },
      ],
    );
    const inactiveOpen = await fetch(stickers, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'open', table_id: 'cloud-table-inactive' }),
    });
    assert.equal(inactiveOpen.status, 404);
    assert.equal((await inactiveOpen.json()).code, 'invalid_pos_table');
    const accept = (table_id: string, confirmed = true) =>
      fetch(`${route}/accept`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ table_id, confirmed }),
      });
    const orders = () =>
      db.prepare("SELECT id, table_id FROM orders WHERE table_id LIKE 'cloud-table-%'").all();
    assert.equal((await fetch(route)).status, 401);
    assert.equal((await fetch(route, { headers: headersFor(staff) })).status, 403);
    assert.equal((await accept('cloud-table-a', false)).status, 400);
    assert.deepEqual(outbound, []);
    const changeAll = (action: 'open' | 'close', confirmed: boolean) =>
      fetch(stickers, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, all_tables: true, confirmed }),
      });
    assert.equal((await changeAll('open', false)).status, 400);
    assert.deepEqual(outbound, []);
    const opened = await changeAll('open', true);
    assert.equal(opened.status, 200);
    const openResults = (await opened.json()).tables as { id: string; data_url?: string }[];
    assert.deepEqual(
      openResults.map((table) => table.id),
      ['cloud-table-a', 'cloud-table-b'],
    );
    assert.ok(openResults.every((table) => table.data_url?.startsWith('data:image/png;')));
    const closed = await changeAll('close', true);
    assert.equal(closed.status, 200);
    const closeResults = (await closed.json()).tables as { id: string; closed: boolean }[];
    assert.deepEqual(
      closeResults.map((table) => table.id),
      ['cloud-table-a', 'cloud-table-b', 'cloud-table-inactive'],
    );
    assert.ok(closeResults.every((table) => table.closed));
    outbound.length = 0;
    const unmapped = await fetch(route, { headers });
    assert.equal(unmapped.status, 200);
    assert.equal((await unmapped.json()).validation, 'missing_product_mapping');
    assert.equal((await accept('cloud-table-a')).status, 409);
    assert.equal(orders().length, 0);
    order.items[0].external_id = 'cloud-product';
    const preview = await fetch(route, { headers });
    const previewData = await preview.json();
    assert.equal(previewData.validation, null);
    assert.deepEqual(
      previewData.tables.map((table: { id: string }) => table.id),
      ['cloud-table-a'],
    );
    const mismatchedTable = await accept('cloud-table-b');
    assert.equal(mismatchedTable.status, 409);
    assert.equal((await mismatchedTable.json()).code, 'cloud_table_mismatch');
    assert.equal(orders().length, 0);
    const accepted = await accept('cloud-table-a');
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const receipt = await accepted.json();
    assert.ok(receipt.pos_order_number);
    assert.equal(orders().length, 1);
    const placed = orders()[0];
    const lines = () =>
      db
        .prepare('SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ?')
        .all(placed.id);
    assert.deepEqual(lines(), [{ product_id: 'cloud-product', quantity: 2, unit_price: 42 }]);
    assert.equal(
      inbox
        .openInbox()
        .prepare('SELECT actor_id FROM order_acceptances WHERE event_id = ?')
        .get(eventId).actor_id,
      actor,
    );
    assert.deepEqual(await (await accept('cloud-table-a')).json(), receipt);
    // Simulate losing the inbox commit after the POS order was durably committed.
    inbox.openInbox().prepare('DELETE FROM order_ack_jobs WHERE event_id = ?').run(eventId);
    inbox.openInbox().prepare('DELETE FROM order_acceptances WHERE event_id = ?').run(eventId);
    inbox
      .openInbox()
      .prepare("UPDATE inbox_events SET status = 'received' WHERE event_id = ?")
      .run(eventId);
    assert.deepEqual(await (await accept('cloud-table-a')).json(), receipt);
    assert.equal(orders().length, 1);
    assert.equal(lines().length, 1);
    await waitFor(() => tickets === 1);
    assert.ok(
      outbound.length > 0 &&
        outbound.every(
          (path) => path === `GET /api/v1/connectors/events/${eventId}/order?addons=1`,
        ),
    );
    assertEqualOrThrow(
      tickets,
      1,
      'Cloud acceptance places and prints one fixture order with no Cloud write',
    );

    const { fetchConnectorEvents } = require('../main/services/qr-cloud/client');
    const options = { config: config.readConfig(), token: config.readConnectorSetting() };
    pageBody = { events: [{ id: eventId }], next_cursor: eventId };
    assert.equal((await fetchConnectorEvents(options)).nextCursor, eventId);
    pageBody = { events: [], next_cursor: null };
    assert.equal(
      (await fetchConnectorEvents({ ...options, after: eventId })).nextCursor,
      undefined,
    );
    assert.equal(outbound.at(-1), `GET /api/v1/connectors/events?after=${eventId}`);
    pageBody = { events: [{ id: eventId }], next_cursor: eventId };
    await assert.rejects(fetchConnectorEvents({ ...options, after: eventId }), {
      code: 'bad_response',
    });
    assertEqualOrThrow(
      tickets,
      1,
      'pending feed pages through Cloud events without acknowledging them',
    );

    const { processCloudOrderDelivery } = require('../main/services/qr-cloud/order-delivery');
    const jobDb = inbox.openInbox();
    const job = () =>
      jobDb
        .prepare('SELECT acknowledged_at, attempts FROM order_ack_jobs WHERE event_id = ?')
        .get(eventId);
    const signal = new AbortController().signal;
    assert.equal(acknowledgements.length, 0);
    await processCloudOrderDelivery(config.readConfig(), signal);
    assert.deepEqual(job(), { acknowledged_at: null, attempts: 1 });
    jobDb.prepare('UPDATE order_ack_jobs SET retry_at = 0 WHERE event_id = ?').run(eventId);
    await processCloudOrderDelivery(config.readConfig(), signal);
    assert.ok(job().acknowledged_at);
    assert.deepEqual(acknowledgements[0], acknowledgements[1]);
    assert.equal(lines().length, 1);

    const sync = () =>
      jobDb
        .prepare('SELECT done, last_payload FROM order_status_sync WHERE event_id = ?')
        .get(eventId);
    assert.deepEqual(kitchenReports, [{ order_id: orderId, statuses: ['pending'] }]);
    assert.deepEqual(sync(), { done: 0, last_payload: '["pending"]' });
    await processCloudOrderDelivery(config.readConfig(), signal);
    assert.equal(kitchenReports.length, 1, 'an unchanged kitchen status is not re-sent');
    db.prepare("UPDATE order_items SET status = 'ready' WHERE order_id = ?").run(placed.id);
    await processCloudOrderDelivery(config.readConfig(), signal);
    assert.deepEqual(kitchenReports.at(-1), { order_id: orderId, statuses: ['ready'] });
    db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(placed.id);
    await processCloudOrderDelivery(config.readConfig(), signal);
    assert.deepEqual(kitchenReports.at(-1), { order_id: orderId, statuses: ['served'] });
    assert.deepEqual(sync(), { done: 1, last_payload: '["served"]' });
    const { kitchenStatusOf } = require('../main/services/qr-cloud/order-delivery');
    assert.deepEqual(
      ['pending', 'preparing', 'ready', 'completed', 'voided', undefined].map(kitchenStatusOf),
      ['pending', 'preparing', 'ready', 'served', 'cancelled', 'cancelled'],
    );
    assertEqualOrThrow(
      kitchenReports.length,
      3,
      'POS kitchen progress reaches the Cloud order once per change',
    );

    const automatic = config.updateConfig({ automatic: true });
    const older = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    order.order_id = crypto.randomUUID();
    order.total_satang = 10400;
    order.items[0].unit_price_satang = 4200;
    db.prepare(
      "INSERT INTO addon_groups (id, name, is_required, max_selection) VALUES ('protein', 'Protein', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO addons (id, addon_group_id, name, price) VALUES ('shrimp', 'protein', 'Shrimp', 10)",
    ).run();
    db.prepare(
      "INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('protein', 'cloud-product')",
    ).run();
    const addOn = { id: 'shrimp', name: 'Shrimp', quantity: 1, price_satang: 1000 };
    pageBody = { ...order, items: [{ ...order.items[0], addons: [addOn] }] };
    inbox.storeEvents(
      [
        {
          id: older,
          kind: 'order.created',
          payload: { order_id: crypto.randomUUID() },
          created_at: '2020-01-01T00:00:00Z',
        },
        {
          id: fresh,
          kind: 'order.created',
          payload: { order_id: order.order_id },
          created_at: new Date().toISOString(),
        },
      ],
      { cloudUrl: automatic.cloudUrl, since: automatic.automaticSince },
    );
    await processCloudOrderDelivery(automatic, signal);
    assert.equal(
      jobDb.prepare('SELECT status FROM inbox_events WHERE event_id = ?').get(older).status,
      'received',
    );
    assert.equal(
      jobDb.prepare('SELECT status FROM inbox_events WHERE event_id = ?').get(fresh).status,
      'applied',
    );
    assert.equal(lines().length, 2);
    assert.deepEqual(
      db
        .prepare(`
      SELECT a.addon_id, a.quantity, a.price FROM order_item_addons a
      JOIN order_items i ON i.id = a.order_item_id WHERE i.order_id = ?
    `)
        .all(placed.id),
      [{ addon_id: 'shrimp', quantity: 1, price: 10 }],
    );
    await waitFor(() => tickets === 2);
    assertEqualOrThrow(
      acknowledgements.length,
      3,
      'automatic delivery applies new orders and retries ACK independently',
    );

    const held = crypto.randomUUID();
    order.order_id = crypto.randomUUID();
    order.total_satang = 10000;
    pageBody = {
      ...order,
      items: [{ ...order.items[0], addons: [{ ...addOn, price_satang: 800 }] }],
    };
    inbox.storeEvents(
      [
        {
          id: held,
          kind: 'order.created',
          payload: { order_id: order.order_id },
          created_at: new Date().toISOString(),
        },
      ],
      { cloudUrl: automatic.cloudUrl, since: automatic.automaticSince },
    );
    await processCloudOrderDelivery(automatic, signal);
    assert.deepEqual(
      jobDb.prepare('SELECT status, last_error FROM inbox_events WHERE event_id = ?').get(held),
      { status: 'received', last_error: 'pos_price_changed' },
    );
    assert.equal(lines().length, 2);
    assertEqualOrThrow(
      acknowledgements.length,
      3,
      'a price mismatch stays in the inbox without a POS write or ACK',
    );
  } finally {
    https.request = originalRequest;
    server.closeAllConnections();
    server.close();
    config.updateConfig({ enabled: false });
  }
}

function legacyInboxFixture(target: string): void {
  const Database = require('better-sqlite3');
  const db = new Database(target);
  db.exec(`
    CREATE TABLE inbox_events (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      cloud_created_at TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE poll_log (id INTEGER PRIMARY KEY AUTOINCREMENT, checked_at TEXT, event_count INTEGER, result TEXT);
  `);
  db.prepare(
    'INSERT INTO inbox_events (event_id, kind, payload_json, status) VALUES (?,?,?,?)',
  ).run('evt-legacy-1', 'order.created', JSON.stringify({ order_id: 'cloud-1' }), 'received');
  db.prepare(
    'INSERT INTO inbox_events (event_id, kind, payload_json, status) VALUES (?,?,?,?)',
  ).run('evt-legacy-2', 'order.created', JSON.stringify({ order_id: 'cloud-2' }), 'applied');
  db.close();
}

async function main() {
  resetCounters();
  initDatabase();
  assertEqualOrThrow(
    config.readConfig().enabled,
    false,
    'fresh settings keep the connector disabled',
  );
  assertEqualOrThrow(config.readConfig().cloudUrl, '', 'fresh settings leave the Cloud URL empty');

  console.log('--- 1. Cloud URL validation ---');
  assertEqualOrThrow(
    config.normalizeCloudUrl('https://qr-staging.test'),
    'https://qr-staging.test',
    'https origin is accepted',
  );
  assertEqualOrThrow(
    config.normalizeCloudUrl('https://qr-staging.test/'),
    'https://qr-staging.test',
    'a trailing slash is normalized away',
  );
  expectThrow(
    () => config.normalizeCloudUrl('http://qr-staging.test'),
    'cloud_url_not_https',
    'plain http',
  );
  expectThrow(
    () => config.normalizeCloudUrl('https://user:pw@qr-staging.test'),
    'cloud_url_invalid',
    'URL credentials',
  );
  expectThrow(
    () => config.normalizeCloudUrl('https://qr-staging.test/?x=1'),
    'cloud_url_invalid',
    'query string',
  );
  expectThrow(
    () => config.normalizeCloudUrl('https://127.0.0.1'),
    'cloud_url_private_target',
    'loopback literal',
  );
  expectThrow(
    () => config.normalizeCloudUrl('https://192.168.1.5'),
    'cloud_url_private_target',
    'LAN literal',
  );
  expectThrow(
    () => config.normalizeCloudUrl('https://localhost'),
    'cloud_url_private_target',
    'localhost name',
  );
  expectThrow(
    () => config.normalizeCloudUrl('ftp://qr-staging.test'),
    'cloud_url_not_https',
    'ftp',
  );

  console.log('--- 2. Bounded settings ---');
  expectThrow(
    () => config.updateConfig({ pollIntervalMs: 100 }),
    'poll_interval_invalid',
    'poll interval below the floor',
  );
  expectThrow(() => config.updateConfig({ retryMax: 99 }), 'retry_invalid', 'retry ceiling');
  expectThrow(
    () => config.updateConfig({ mode: 'cloud' as never }),
    'mode_invalid',
    'unknown mode',
  );
  const applied = config.updateConfig({
    enabled: true,
    cloudUrl: 'https://qr-staging.test',
    pollIntervalMs: 5000,
    timeoutMs: 5000,
    retryMax: 2,
    reconcileIntervalMs: 60000,
    autoStart: false,
  });
  assertEqualOrThrow(applied.pollIntervalMs, 5000, 'poll interval persisted');
  assertEqualOrThrow(
    config.readConfig().cloudUrl,
    'https://qr-staging.test',
    'Cloud URL persisted',
  );

  console.log('--- 3. Credential handling ---');
  config.writeConnectorToken('test-token-abcdef');
  assertOrThrow(config.hasConnectorToken(), 'token is stored');
  const statusWithToken = connector.getQrCloudStatus();
  assertEqualOrThrow(statusWithToken.has_token, true, 'status reports token presence');
  assertEqualOrThrow(
    statusWithToken.authentication,
    'unchecked',
    'storing a token does not authenticate',
  );
  assertOrThrow(
    !JSON.stringify(statusWithToken).includes('test-token-abcdef'),
    'status never contains the token value',
  );
  const diagnosticsWithToken = connector.getQrCloudDiagnostics();
  assertOrThrow(
    !JSON.stringify(diagnosticsWithToken).includes('test-token-abcdef'),
    'diagnostics never contain the token value',
  );
  expectThrow(
    () => config.writeConnectorToken('has space token'),
    'token_invalid',
    'whitespace in token',
  );
  encryptionAvailable = false;
  expectThrow(
    () => config.writeConnectorToken('replacement-token'),
    'credential_storage_unavailable',
    'replacement fails closed when encryption is unavailable',
  );
  const settings = getDatabase().prepare('SELECT value FROM settings WHERE key = ?');
  assertEqualOrThrow(
    settings.get(config.QR_CLOUD_TOKEN_KEY).value,
    'safe-storage:v1',
    'SQLite only holds the marker',
  );
  encryptionAvailable = true;
  assertEqualOrThrow(
    config.readConnectorSetting(),
    'test-token-abcdef',
    'failed replacement preserves the previous token',
  );
  config.writeConnectorToken('rotated-token');
  assertEqualOrThrow(
    config.readConnectorSetting(),
    'rotated-token',
    'replacement reads back from protected storage',
  );
  const { upsertSettings } = require('../main/db');
  upsertSettings({ [config.QR_CLOUD_TOKEN_KEY]: 'legacy-plaintext-token' });
  assertEqualOrThrow(
    config.readConnectorSetting(),
    'legacy-plaintext-token',
    'an upgrade retains the old credential',
  );
  assertEqualOrThrow(
    settings.get(config.QR_CLOUD_TOKEN_KEY).value,
    'safe-storage:v1',
    'the old credential migrates to protected storage',
  );

  console.log('--- 4. TLS preview without trust ---');
  const inspected = tls.inspectCaCertificate(CA_PEM);
  assertOrThrow(inspected.is_ca, 'fixture is a CA certificate');
  assertEqualOrThrow(
    inspected.fingerprint_sha256,
    tls.normalizeFingerprint(
      crypto
        .createHash('sha256')
        .update(Buffer.from(CA_PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'))
        .digest('hex'),
    ),
    'reported fingerprint is the SHA-256 of the DER bytes',
  );
  expectThrow(() => tls.inspectCaCertificate(LEAF_PEM), 'certificate_not_ca', 'leaf certificate');
  expectThrow(
    () => tls.inspectCaCertificate('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'),
    'certificate_private_key_rejected',
    'private key upload',
  );
  expectThrow(
    () => tls.inspectCaCertificate('not a certificate'),
    'certificate_invalid',
    'garbage',
  );
  expectThrow(
    () =>
      tls.approveCaCertificate({
        certificate: CA_PEM,
        expected_fingerprint: '00'.repeat(32),
        confirm: true,
      }),
    'fingerprint_mismatch',
    'fingerprint mismatch',
  );
  expectThrow(
    () =>
      tls.approveCaCertificate({
        certificate: CA_PEM,
        expected_fingerprint: inspected.fingerprint_sha256,
        confirm: false,
      }),
    'confirmation_required',
    'missing confirmation',
  );
  const approved = tls.approveCaCertificate({
    certificate: CA_PEM,
    expected_fingerprint: inspected.fingerprint_sha256,
    confirm: true,
  });
  assertEqualOrThrow(
    approved.fingerprint_sha256,
    inspected.fingerprint_sha256,
    'approval records the verified fingerprint',
  );
  assertOrThrow(tls.caStatus().configured, 'approved CA is configured');
  assertOrThrow(
    fs.existsSync(tls.caFilePath()),
    'approved CA is stored in the application-managed directory',
  );
  assertOrThrow(
    tls.caFilePath().startsWith(inboxDir),
    'the approved CA lives only in the application-managed directory',
  );
  tls.removeApprovedCa();
  assertEqualOrThrow(tls.caStatus().configured, false, 'CA can be removed');

  console.log('--- 5. Inbox durability and deduplication ---');
  const firstPoll = inbox.storeEvents([
    {
      id: 'evt-1',
      kind: 'order.created',
      payload: { order_id: 'c1' },
      created_at: '2026-11-01T00:00:00Z',
    },
    { id: 'evt-2', kind: 'order.created', payload: { order_id: 'c2' } },
  ]);
  assertEqualOrThrow(firstPoll.stored, 2, 'two events stored');
  const replay = inbox.storeEvents([
    { id: 'evt-1', kind: 'order.created', payload: { order_id: 'c1' } },
    { id: 'evt-3', kind: 'order.created', payload: { order_id: 'c3' } },
  ]);
  assertEqualOrThrow(replay.stored, 1, 'only the new event is stored on replay');
  assertEqualOrThrow(replay.duplicates, 1, 'the repeated event is counted as a duplicate');
  const rejected = inbox.storeEvents([{ id: '', kind: 'x', payload: {} }, { id: 'evt-4' }]);
  assertEqualOrThrow(rejected.rejected, 2, 'malformed events are rejected, not stored');
  assertEqualOrThrow(inbox.inboxSummary().total, 3, 'inbox total reflects stored events only');

  const legacyPath = path.join(tempRoot, 'legacy', 'connector.db');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  legacyInboxFixture(legacyPath);
  const before = crypto.createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex');
  const imported = inbox.importLegacyInbox(legacyPath);
  assertEqualOrThrow(imported.copied, 2, 'legacy rows copied');
  assertOrThrow(fs.existsSync(imported.backup_path), 'a backup of the source was written');
  const after = crypto.createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex');
  assertEqualOrThrow(after, before, 'the source database is byte-identical after import');
  const reimported = inbox.importLegacyInbox(legacyPath);
  assertEqualOrThrow(reimported.copied, 0, 're-import copies nothing twice');
  assertEqualOrThrow(reimported.duplicates, 2, 're-import reports duplicates');
  const Database = require('better-sqlite3');
  const legacyWriter = new Database(legacyPath);
  try {
    legacyWriter.pragma('journal_mode = WAL');
    legacyWriter.pragma('wal_autocheckpoint = 0');
    legacyWriter
      .prepare(
        'INSERT INTO inbox_events (event_id, kind, payload_json, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('wal-event', 'order.created', '{}', '2026-11-02 03:04:05');
    const walImport = inbox.importLegacyInbox(legacyPath);
    assertEqualOrThrow(walImport.copied, 1, 'import includes committed WAL rows');
    const importedEvent = inbox
      .openInbox()
      .prepare('SELECT updated_at FROM inbox_events WHERE event_id = ?')
      .get('wal-event');
    assertEqualOrThrow(
      importedEvent.updated_at,
      '2026-11-02 03:04:05',
      'import preserves update timestamps',
    );
    const backup = new Database(walImport.backup_path, { readonly: true });
    try {
      assertEqualOrThrow(
        backup.prepare('SELECT COUNT(*) AS count FROM inbox_events').get().count,
        3,
        'rollback backup includes WAL rows',
      );
    } finally {
      backup.close();
    }
  } finally {
    legacyWriter.close();
  }
  inbox.closeInbox();
  assertEqualOrThrow(
    inbox.inboxSummary().total,
    6,
    'imported and polled rows survive an inbox reopen',
  );
  expectThrow(
    () => inbox.importLegacyInbox(path.join(tempRoot, 'nope.db')),
    'import_source_invalid',
    'a source that is not connector.db',
  );
  expectThrow(
    () => inbox.importLegacyInbox(path.join(tempRoot, 'missing', 'connector.db')),
    'import_source_missing',
    'a missing connector.db',
  );
  const corruptPath = path.join(tempRoot, 'corrupt', 'connector.db');
  fs.mkdirSync(path.dirname(corruptPath));
  fs.writeFileSync(corruptPath, 'not a database');
  expectThrow(
    () => inbox.importLegacyInbox(corruptPath),
    'import_source_invalid',
    'corrupt source',
  );
  assertEqualOrThrow(inbox.inboxSummary().total, 6, 'a corrupt source leaves the inbox intact');

  console.log('--- 6. Lifecycle: connect, auth failure, stop ---');
  const ordersBefore = (getDatabase().prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c;
  let calls = 0;
  connector.__setFetchEventsForTests(async () => {
    calls += 1;
    return {
      events: [{ id: 'evt-live-1', kind: 'order.created', payload: { order_id: 'c9' } }],
      status: 200,
      latencyMs: 5,
    };
  });
  config.updateConfig({ enabled: true, autoStart: true, pollIntervalMs: 5000 });
  connector.startQrCloudConnector({ force: true });
  await waitFor(() => connector.getQrCloudStatus().state === 'CONNECTED_POLLING');
  assertEqualOrThrow(
    connector.getQrCloudStatus().state,
    'CONNECTED_POLLING',
    'polling reaches CONNECTED_POLLING',
  );
  assertOrThrow(calls >= 1, 'at least one poll happened');
  assertEqualOrThrow(
    connector.getQrCloudStatus().authentication,
    'accepted',
    'successful poll verifies authentication',
  );
  const ordersAfter = (getDatabase().prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c;
  assertEqualOrThrow(ordersAfter, ordersBefore, 'polling never creates POS orders');
  assertOrThrow(inbox.inboxSummary().total >= 4, 'the polled event landed in the durable inbox');
  assertEqualOrThrow(
    connector.getQrCloudStatus().websocket.available,
    false,
    'WebSocket is reported as unavailable until the Cloud contract is deployed',
  );

  connector.__setFetchEventsForTests(async () => {
    const { QrCloudClientError } = require('../main/services/qr-cloud/client');
    throw new QrCloudClientError('auth_failed', 'HTTP 401');
  });
  connector.startQrCloudConnector({ force: true });
  await waitFor(() => connector.getQrCloudStatus().state === 'AUTH_FAILED');
  assertEqualOrThrow(connector.getQrCloudStatus().state, 'AUTH_FAILED', '401 maps to AUTH_FAILED');
  assertEqualOrThrow(
    connector.getQrCloudStatus().authentication,
    'rejected',
    '401 rejects credentials',
  );
  connector.applyQrCloudConfig({ mode: 'legacy_relay' });
  assertOrThrow(!connector.__isLoopArmedForTests(), 'legacy mode stops integrated polling');
  assertEqualOrThrow(
    connector.getQrCloudStatus().authentication,
    'unchecked',
    'switching modes clears auth evidence',
  );
  config.updateConfig({ mode: 'integrated' });

  connector.stopQrCloudConnector();
  assertEqualOrThrow(
    connector.getQrCloudStatus().state,
    'DISABLED',
    'stop leaves the connector disabled',
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertOrThrow(!connector.__isLoopArmedForTests(), 'no timer or request survives stop');

  console.log('--- 7. No duplicate polling loops on repeated start ---');
  let loopCalls = 0;
  connector.__setFetchEventsForTests(async () => {
    loopCalls += 1;
    return { events: [], status: 200, latencyMs: 1 };
  });
  connector.startQrCloudConnector({ force: true });
  connector.startQrCloudConnector({ force: true });
  await waitFor(() => connector.getQrCloudStatus().state === 'CONNECTED_POLLING');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertOrThrow(
    loopCalls <= 2,
    `repeated start does not multiply polling loops (calls=${loopCalls})`,
  );
  connector.stopQrCloudConnector();

  console.log('--- 8. Offline retry and cancellation ---');
  const { QrCloudClientError } = require('../main/services/qr-cloud/client');
  connector.__setFetchEventsForTests(async () => {
    throw new QrCloudClientError('offline', 'ECONNREFUSED');
  });
  connector.startQrCloudConnector();
  await waitFor(() => connector.getQrCloudStatus().state === 'OFFLINE');
  assertOrThrow(connector.__isLoopArmedForTests(), 'offline state schedules a retry');
  let aborted = false;
  connector.__setFetchEventsForTests(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new QrCloudClientError('timeout'));
          },
          { once: true },
        );
      }),
  );
  connector.startQrCloudConnector();
  connector.applyQrCloudConfig({ enabled: false });
  assertOrThrow(aborted, 'disabling aborts an in-flight poll');
  assertEqualOrThrow(config.readConfig().enabled, false, 'disabled state is persisted');
  assertOrThrow(!connector.__isLoopArmedForTests(), 'disabling cancels pending retries');

  console.log('--- 9. Error history clearing keeps events ---');
  const totalBeforeClear = inbox.inboxSummary().total;
  connector.clearQrCloudErrorHistory();
  assertEqualOrThrow(
    inbox.inboxSummary().total,
    totalBeforeClear,
    'clearing errors keeps every event',
  );
  assertEqualOrThrow(connector.getQrCloudStatus().last_error, null, 'last error is cleared');

  console.log('--- 10. Legacy configuration preview, import, and cutover ---');
  if (process.platform === 'win32') isPackaged = false;
  const db = getDatabase();
  const actor = 'fixture-legacy-import-owner';
  const root = path.join(tempRoot, 'legacy');
  const source = path.join(root, 'config', 'connector.env');
  const caSource = path.join(root, 'certs', 'root.crt');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(caSource), { recursive: true });
  assertEqualOrThrow(
    legacyImport.previewLegacyImport(actor, root).source_found,
    false,
    'missing config',
  );
  fs.writeFileSync(caSource, CA_PEM);
  const token = crypto.randomBytes(32).toString('hex');
  const fixture = (url = 'https://qr-staging.test', credential = token, interval = '5000') =>
    `# Test fixture\r\nCLOUD_URL="${url}"\r\nCONNECTOR_TOKEN='${credential}'\r\nPOLL_INTERVAL_MS=${interval} # milliseconds\r\nCONNECTOR_HOME=C:\\ignored\r\n`;
  for (const [value, code] of [
    [fixture(undefined, ''), 'token_invalid'],
    [fixture('http://qr-staging.test'), 'cloud_url_not_https'],
    [fixture('https://qr-staging.test/private'), 'cloud_url_invalid'],
    [fixture(undefined, undefined, '3000'), 'poll_interval_invalid'],
    [fixture(undefined, undefined, '5e3'), 'poll_interval_invalid'],
    [fixture() + 'CLOUD_URL=x', 'legacy_env_invalid'],
    [fixture() + 'unclosed="value', 'legacy_env_invalid'],
    [fixture() + 'invalid=' + ' '.repeat(7000) + '"unterminated', 'legacy_env_invalid'],
  ]) {
    fs.writeFileSync(source, value);
    const invalid = legacyImport.previewLegacyImport(actor, root);
    assertOrThrow(
      invalid.source_found &&
        !invalid.ready_for_import &&
        invalid.preview_id === null &&
        invalid.validation_errors.includes(code),
      `preview reports ${code} without authorizing import`,
    );
  }
  fs.writeFileSync(source, 'x'.repeat(8193));
  expectThrow(
    () => legacyImport.previewLegacyImport(actor, root),
    'legacy_file_too_large',
    'size limit',
  );
  fs.writeFileSync(source, fixture('http://qr-staging.test', '', '5000'));
  const partial = legacyImport.previewLegacyImport(actor, root);
  assertOrThrow(
    partial.connector_token_present === false &&
      partial.poll_interval_ms === 5000 &&
      partial.cloud_url === null &&
      partial.validation_errors.join(',') === 'cloud_url_not_https,token_invalid',
    'partial preview preserves valid fields and reports each invalid field',
  );
  fs.writeFileSync(source, fixture());
  fs.writeFileSync(caSource, 'invalid certificate fixture');
  const invalidCa = legacyImport.previewLegacyImport(actor, root);
  assertOrThrow(
    invalidCa.ca_certificate_found &&
      invalidCa.ca_certificate === null &&
      invalidCa.ca_error === 'certificate_invalid' &&
      !invalidCa.ca_matches_expected,
    'invalid CA is reported as present and cannot be trusted',
  );
  fs.writeFileSync(caSource, CA_PEM);
  const linkedRoot = path.join(tempRoot, 'linked');
  fs.mkdirSync(linkedRoot);
  fs.symlinkSync(path.dirname(source), path.join(linkedRoot, 'config'), 'junction');
  expectThrow(
    () => legacyImport.previewLegacyImport(actor, linkedRoot),
    'legacy_unsafe_file',
    'linked ancestor',
  );
  const currentToken = config.readConnectorSetting();
  const storedSettings = () => db.prepare('SELECT * FROM settings ORDER BY key').all();
  const beforeImport = JSON.stringify(storedSettings());
  const preview = legacyImport.previewLegacyImport(actor, root);
  assertOrThrow(
    preview.source_found && preview.ready_for_import,
    'valid legacy settings are previewed',
  );
  assertEqualOrThrow(preview.cloud_url, 'https://qr-staging.test', 'legacy URL previewed');
  assertEqualOrThrow(preview.poll_interval_ms, 5000, 'legacy interval previewed');
  assertOrThrow(
    preview.connector_token_present && preview.conflicts.includes('credential'),
    'credential conflict detected',
  );
  assertOrThrow(
    preview.ca_certificate.is_ca && !preview.ca_matches_expected,
    'untrusted CA metadata only',
  );
  assertOrThrow(
    preview.ca_certificate.basic_constraints?.critical &&
      preview.ca_certificate.basic_constraints.path_length === null,
    'CA preview exposes the Basic Constraints extension',
  );
  assertOrThrow(
    !JSON.stringify(preview).includes(token) && !JSON.stringify(preview).includes(CA_PEM),
    'preview redacts secrets and PEM',
  );
  assertOrThrow(JSON.stringify(storedSettings()) === beforeImport, 'preview changes no settings');
  const commit = { preview_id: preview.preview_id, confirm: true, replace_credential: true };
  expectThrow(
    () => legacyImport.commitLegacyImport(actor, { ...commit, confirm: false }, root),
    'confirmation_required',
    'confirmation',
  );
  expectThrow(
    () => legacyImport.commitLegacyImport(actor, { ...commit, replace_credential: false }, root),
    'legacy_replace_credential_required',
    'separate overwrite confirmation',
  );
  expectThrow(
    () => legacyImport.commitLegacyImport('other-user', commit, root),
    'legacy_preview_stale',
    'preview is bound to actor',
  );
  fs.writeFileSync(source, fixture(undefined, undefined, '6000'));
  expectThrow(
    () => legacyImport.commitLegacyImport(actor, commit, root),
    'legacy_preview_stale',
    'source changed after preview',
  );
  fs.writeFileSync(source, fixture());
  db.exec(`CREATE TEMP TRIGGER fail_legacy_audit BEFORE INSERT ON auth_audit_log
    WHEN NEW.event_type = 'qr_cloud_legacy_config_import'
    BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
  expectThrow(
    () => legacyImport.commitLegacyImport(actor, commit, root),
    'SQLITE_CONSTRAINT_TRIGGER',
    'audit write failure rolls back',
  );
  db.exec('DROP TRIGGER fail_legacy_audit');
  assertOrThrow(
    JSON.stringify(storedSettings()) === beforeImport,
    'failed commit preserves prior settings',
  );
  assertOrThrow(
    config.readConnectorSetting() === currentToken,
    'failed commit preserves prior encrypted token',
  );
  encryptionAvailable = false;
  expectThrow(
    () =>
      legacyImport.commitLegacyImport(
        actor,
        { ...commit, preview_id: legacyImport.previewLegacyImport(actor, root).preview_id },
        root,
      ),
    'credential_storage_unavailable',
    'commit requires protected storage',
  );
  encryptionAvailable = true;
  const bytesBefore = fs.readFileSync(source);
  const caBefore = fs.readFileSync(caSource);
  const saleData = () =>
    ['products', 'bills'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const saleDataBefore = JSON.stringify(saleData());
  let cutoverCalls = 0;
  connector.__setFetchEventsForTests(async () => {
    cutoverCalls += 1;
    throw new QrCloudClientError('tls_failed');
  });
  legacyImport.commitLegacyImport(actor, commit, root);
  assertOrThrow(
    config.readConnectorSetting() === token,
    'imported token reads from protected storage',
  );
  assertOrThrow(
    !JSON.stringify(storedSettings()).includes(token),
    'imported token is absent from SQLite settings',
  );
  assertOrThrow(
    config.readConfig().cutoverPending && !config.readConfig().enabled,
    'cutover hold persists with polling disabled',
  );
  expectThrow(
    () => config.updateConfig({ enabled: true }),
    'cutover_required',
    'normal enable blocked',
  );
  connector.startQrCloudConnector({ force: true });
  assertEqualOrThrow(cutoverCalls, 0, 'import and force retry do not make Cloud requests');
  expectThrow(
    () =>
      legacyImport.importLegacyCa(
        {
          confirm: true,
          expected_fingerprint: preview.ca_certificate.fingerprint_sha256,
        },
        root,
      ),
    'fingerprint_mismatch',
    'legacy CA requires the expected staging fingerprint',
  );
  const assertRejects = require('node:assert/strict').rejects;
  await assertRejects(legacyImport.approveLegacyCutover(actor, false), {
    code: 'confirmation_required',
  });
  assertEqualOrThrow(cutoverCalls, 0, 'unconfirmed cutover makes no request');
  const failed = await legacyImport.approveLegacyCutover(actor, true);
  assertOrThrow(
    !failed.ok && config.readConfig().cutoverPending,
    'failed verification leaves the hold in place',
  );
  const https = require('node:https');
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const originalRequest = https.request;
  const outbound: string[] = [];
  https.request = (
    options: { method: string; path: string },
    callback: (response: unknown) => void,
  ) => {
    const request = new EventEmitter();
    outbound.push(`${options.method} ${options.path}`);
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      callback(response);
      response.end(
        JSON.stringify({ events: [{ id: 'test-only', kind: 'order.created', payload: {} }] }),
      );
    };
    return request;
  };
  let verified;
  try {
    connector.__setFetchEventsForTests(null);
    verified = await legacyImport.approveLegacyCutover(actor, true);
  } finally {
    https.request = originalRequest;
  }
  assertOrThrow(
    verified.ok && !config.readConfig().cutoverPending,
    'verified cutover clears the hold',
  );
  assertOrThrow(
    !config.readConfig().enabled && !connector.__isLoopArmedForTests(),
    'verified cutover does not enable polling',
  );
  assertEqualOrThrow(cutoverCalls, 1, 'failed verification made one transport attempt');
  assertEqualOrThrow(
    outbound.join(','),
    'GET /api/v1/connectors/events',
    'cutover makes only a feed GET, with no ACK or Cloud price write',
  );
  assertEqualOrThrow(
    inbox.inboxSummary().total,
    totalBeforeClear,
    'test connection never persists events',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS c FROM orders').get().c,
    ordersBefore,
    'import and verification create no orders',
  );
  assertOrThrow(
    JSON.stringify(saleData()) === saleDataBefore,
    'import and verification leave products and payments unchanged',
  );
  assertOrThrow(
    fs.readFileSync(source).equals(bytesBefore) && fs.readFileSync(caSource).equals(caBefore),
    'legacy files remain byte identical',
  );
  const audit = db
    .prepare(
      "SELECT user_id, details_json FROM auth_audit_log WHERE event_type = 'qr_cloud_legacy_config_import'",
    )
    .get();
  assertOrThrow(
    audit.user_id === actor && !audit.details_json.includes(token),
    'successful import is attributed and sanitized',
  );
  const setupPreview = legacyImport.previewLegacyImport(actor, root);
  legacyImport.commitLegacyImport(
    actor,
    { preview_id: setupPreview.preview_id, confirm: true, replace_credential: true },
    root,
  );
  let setupRequests = 0;
  let setupSucceeds = false;
  connector.__setFetchEventsForTests(async () => {
    setupRequests += 1;
    if (!setupSucceeds) throw new QrCloudClientError('tls_failed');
    return { events: [], status: 200, latencyMs: 1 };
  });
  await assertRejects(legacyImport.activateQrCloudSetup(actor, false), {
    code: 'confirmation_required',
  });
  assertEqualOrThrow(setupRequests, 0, 'setup requires cutover confirmation before testing');
  const rejectedSetup = await legacyImport.activateQrCloudSetup(actor, true);
  assertOrThrow(
    !rejectedSetup.ok &&
      !config.readConfig().enabled &&
      config.readConfig().cutoverPending &&
      !connector.__isLoopArmedForTests(),
    'failed setup test leaves cutover on hold and polling off',
  );
  setupSucceeds = true;
  const activated = await legacyImport.activateQrCloudSetup(actor, true);
  await waitFor(() => connector.getQrCloudStatus().state === 'CONNECTED_POLLING');
  assertOrThrow(
    activated.ok && config.readConfig().enabled && !config.readConfig().cutoverPending,
    'successful setup clears the hold and enables polling',
  );
  assertEqualOrThrow(
    setupRequests,
    3,
    'setup made one failed test, one successful test, and one first poll',
  );
  connector.applyQrCloudConfig({ enabled: false });
  const encryptedSlots = () =>
    fs
      .readdirSync(tempRoot)
      .filter(
        (name: string) => name.startsWith(config.QR_CLOUD_TOKEN_KEY) && name.endsWith('.enc'),
      );
  assertEqualOrThrow(encryptedSlots().length, 1, 'only the active encrypted credential remains');
  await verifyOrderAcceptance();
  config.clearConnectorToken();
  assertEqualOrThrow(encryptedSlots().length, 0, 'revoking the token removes the encrypted slot');

  connector.__setFetchEventsForTests(null);
  inbox.closeInbox();
  closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const results = getResults();
  console.log(`\nQR cloud connector: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
