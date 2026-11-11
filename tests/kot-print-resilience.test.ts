/**
 * Kitchen ticket printing against a fake raw-TCP (port 9100) printer: a busy printer that resets or
 * refuses connections is retried, queued jobs come out one at a time and once each, a connection
 * that never opens is retried while a job that already sent bytes is not, an out-of-paper printer
 * holds the ticket back, and a held ticket is offered for a manual reprint once paper is loaded.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/kot-print-resilience.test.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kot-resilience-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { printViaNetwork } = require('../main/printers/thermal');
const {
  networkPrintPolicy,
  PAPER_STATUS_REQUEST,
  parsePaperStatusByte,
  probeNetworkPrinter,
} = require('../main/printers/network-status');
const { printOrderKot } = require('../main/routes/printers');
const unprintedKots = require('../main/services/unprinted-kots');
const { recentKdsAlerts, clearKdsAlertsForTest } = require('../main/services/kds-alerts');
const { handleKdsReprintKot } = require('../main/services/kds-kot-actions');

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const STATUS_BYTE = { ok: 0x12, near_end: 0x1e, paper_out: 0x72 } as const;

type FakePrinterState = {
  paper: keyof typeof STATUS_BYTE | 'silent';
  /** Connections to reset straight away, as a printer busy with another job does. */
  resetNext: number;
};

/** A raw-TCP printer that answers `DLE EOT 4` and keeps each connection's payload as one job. */
async function startFakePrinter(state: FakePrinterState, port = 0) {
  const jobs: Buffer[] = [];
  const stats = { connections: 0, open: 0, maxOpen: 0, statusRequests: 0 };
  const server = net.createServer((socket) => {
    stats.connections++;
    if (state.resetNext > 0) {
      state.resetNext--;
      socket.resetAndDestroy();
      return;
    }
    stats.open++;
    stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    let payload = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      let data = chunk;
      if (payload.length === 0 && data.subarray(0, 3).equals(PAPER_STATUS_REQUEST)) {
        stats.statusRequests++;
        data = data.subarray(3);
        if (state.paper !== 'silent') socket.write(Buffer.from([STATUS_BYTE[state.paper]]));
      }
      payload = Buffer.concat([payload, data]);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      stats.open--;
      if (payload.length > 0) jobs.push(payload);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    jobs,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Waits for the printer to see every connection close, so its job list is complete. */
async function settle(printer: { stats: { open: number } }) {
  for (let i = 0; i < 100 && printer.stats.open > 0; i++) await delay(10);
  await delay(20);
}

class StuckSocket extends EventEmitter {
  writes: Buffer[] = [];
  timeoutCb?: () => void;
  connectCb?: () => void;
  connect(_port: number, _host: string, cb?: () => void) {
    this.connectCb = cb;
    return this;
  }
  write(chunk: Buffer, cb?: () => void) {
    this.writes.push(Buffer.from(chunk));
    if (cb) process.nextTick(cb);
    return true;
  }
  end() {
    return this;
  }
  destroy() {
    return this;
  }
  setTimeout(_ms: number, cb?: () => void) {
    if (cb) this.timeoutCb = cb;
    return this;
  }
}

async function withMockSockets(
  make: () => StuckSocket,
  run: (sockets: StuckSocket[]) => Promise<void>,
) {
  const original = net.Socket;
  const sockets: StuckSocket[] = [];
  (net as any).Socket = function () {
    const socket = make();
    sockets.push(socket);
    return socket;
  };
  try {
    await run(sockets);
  } finally {
    (net as any).Socket = original;
  }
}

async function networkCases() {
  {
    assert.equal(parsePaperStatusByte(0x12), 'ok');
    assert.equal(parsePaperStatusByte(0x1e), 'near_end');
    assert.equal(parsePaperStatusByte(0x72), 'paper_out');
    assert.equal(parsePaperStatusByte(0x00), null, 'a byte without the fixed bits is no status');
    assert.equal(parsePaperStatusByte(0x10), null, 'an ASB byte is not a DLE EOT 4 reply');
    console.log('  ✓ DLE EOT 4 replies decode to ok, near end and paper out');
  }

  {
    const state: FakePrinterState = { paper: 'ok', resetNext: 2 };
    const printer = await startFakePrinter(state);
    const ticket = Buffer.from('KOT busy printer\n');
    const result = await printViaNetwork('127.0.0.1', printer.port, ticket);
    await settle(printer);
    assert.equal(
      result.ok,
      true,
      `a busy printer is retried until it takes the job: ${result.detail}`,
    );
    assert.equal(printer.stats.connections, 3, 'two resets, then the third try prints');
    assert.deepEqual(printer.jobs, [ticket], 'the ticket prints exactly once');
    await printer.close();
    console.log('  ✓ busy printer (connection reset): backs off and prints once');
  }

  {
    const port = await freePort();
    const ticket = Buffer.from('KOT printer rebooting\n');
    const pending = printViaNetwork('127.0.0.1', port, ticket);
    await delay(700);
    const printer = await startFakePrinter({ paper: 'ok', resetNext: 0 }, port);
    const result = await pending;
    await settle(printer);
    assert.equal(result.ok, true, `refused connections are retried: ${result.detail}`);
    assert.deepEqual(printer.jobs, [ticket], 'the ticket prints once the printer listens');
    await printer.close();
    console.log('  ✓ connection refused while the printer starts: retried, prints once');
  }

  {
    const port = await freePort();
    const started = Date.now();
    const result = await printViaNetwork('127.0.0.1', port, Buffer.from('nobody home'));
    assert.equal(result.ok, false);
    assert.match(result.detail || '', /ECONNREFUSED.*\(after 3 attempts\)/);
    assert.ok(Date.now() - started >= 1400, 'the retries wait 500 ms, then 1 s');
    console.log('  ✓ a printer that stays off fails after 3 tries, with the reason');
  }

  {
    const printer = await startFakePrinter({ paper: 'ok', resetNext: 0 });
    const tickets = Array.from({ length: 6 }, (_, i) => Buffer.from(`KOT rush ${i}\n`));
    const results = await Promise.all(
      tickets.map((ticket) => printViaNetwork('127.0.0.1', printer.port, ticket)),
    );
    await settle(printer);
    assert.ok(results.every((result: { ok: boolean }) => result.ok));
    assert.equal(printer.stats.maxOpen, 1, 'a rush of tickets goes to the printer one at a time');
    assert.deepEqual(printer.jobs, tickets, 'in order, each exactly once');
    await printer.close();
    console.log('  ✓ rush hour: queued jobs print one at a time, in order, once each');
  }

  {
    const printer = await startFakePrinter({ paper: 'paper_out', resetNext: 0 });
    const result = await printViaNetwork('127.0.0.1', printer.port, Buffer.from('KOT no paper'));
    await settle(printer);
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'Printer is out of paper');
    assert.equal(result.failureClass, 'needs_attention');
    assert.equal(printer.stats.connections, 1, 'out of paper is not retried');
    assert.deepEqual(printer.jobs, [], 'nothing is sent to a printer without paper');
    await printer.close();
    console.log('  ✓ paper out: the ticket is held back, not sent into the printer buffer');
  }

  {
    for (const paper of ['near_end', 'silent'] as const) {
      const printer = await startFakePrinter({ paper, resetNext: 0 });
      const ticket = Buffer.from(`KOT ${paper}\n`);
      const result = await printViaNetwork('127.0.0.1', printer.port, ticket);
      await settle(printer);
      assert.equal(result.ok, true, `${paper}: ${result.detail}`);
      assert.deepEqual(printer.jobs, [ticket]);
      await printer.close();
    }
    console.log('  ✓ paper near end, or a printer that never reports status, still prints');
  }

  {
    const savedDelays = networkPrintPolicy.retryDelaysMs;
    networkPrintPolicy.retryDelaysMs = [5, 5];
    try {
      await withMockSockets(
        () => new StuckSocket(),
        async (sockets) => {
          const pending = printViaNetwork('192.0.2.10', 9100, Buffer.from('timeout'));
          for (let attempt = 0; attempt < 3; attempt++) {
            while (sockets.length <= attempt) await delay(1);
            sockets[attempt].timeoutCb!();
          }
          const result = await pending;
          assert.equal(result.ok, false);
          assert.match(result.detail || '', /Timed out connecting to 192\.0\.2\.10:9100 \(after 3/);
          assert.equal(sockets.length, 3, 'a connect timeout is tried three times');
        },
      );
      await withMockSockets(
        () => {
          const socket = new StuckSocket();
          socket.connect = function (_port, _host, cb) {
            process.nextTick(() => cb?.());
            return this;
          };
          socket.write = function (chunk: Buffer) {
            this.writes.push(Buffer.from(chunk));
            if (!chunk.equals(PAPER_STATUS_REQUEST)) {
              process.nextTick(() =>
                this.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
              );
            }
            return true;
          };
          return socket;
        },
        async (sockets) => {
          const result = await printViaNetwork('192.0.2.11', 9100, Buffer.from('half sent'));
          assert.equal(result.ok, false);
          assert.equal(sockets.length, 1, 'a job that already sent bytes is never retried');
        },
      );
    } finally {
      networkPrintPolicy.retryDelaysMs = savedDelays;
    }
    console.log('  ✓ connect timeout is retried; a job cut off mid-send is not (no double print)');
  }

  {
    const state: FakePrinterState = { paper: 'paper_out', resetNext: 0 };
    const printer = await startFakePrinter(state);
    assert.equal(await probeNetworkPrinter('127.0.0.1', printer.port), 'paper_out');
    state.paper = 'ok';
    assert.equal(await probeNetworkPrinter('127.0.0.1', printer.port), 'ok');
    await settle(printer);
    assert.deepEqual(printer.jobs, [], 'a status probe prints nothing');
    await printer.close();
    assert.equal(await probeNetworkPrinter('127.0.0.1', await freePort()), 'unreachable');
    console.log('  ✓ probing a printer reads its paper status without printing');
  }
}

async function kitchenTicketCases() {
  try {
    initDatabase();
  } catch (error: any) {
    if (error?.code === 'ERR_DLOPEN_FAILED') {
      console.log('  ⚠ Skipping ticket cases: better-sqlite3 is not built for this runtime.');
      process.exit(77);
    }
    throw error;
  }
  const db = getDatabase();
  for (const [key, value] of [
    ['country', 'TH'],
    ['currency', 'THB'],
    ['timezone', 'Asia/Bangkok'],
  ]) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value, now());
  }

  const state: FakePrinterState = { paper: 'paper_out', resetNext: 0 };
  const printer = await startFakePrinter(state);
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, is_default, created_at, updated_at)
     VALUES ('kitchen-printer', 'Kitchen', 'network', '127.0.0.1', ?, 'cols-42', 1, ?, ?)`,
  ).run(printer.port, now(), now());

  const addOrder = (orderNumber: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO orders (order_number, status, type, subtotal, total, created_at, updated_at)
           VALUES (?, 'pending', 'dine_in', 10, 10, datetime('now'), datetime('now'))`,
        )
        .run(orderNumber).lastInsertRowid,
    );
  const addItem = (orderId: number, name: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
           VALUES (?, ?, ?, 10, 1, 10, 10, datetime('now'), datetime('now'))`,
        )
        .run(orderId, `prod-${name}`, name).lastInsertRowid,
    );
  const itemRow = (id: number) => db.prepare('SELECT * FROM order_items WHERE id = ?').get(id);
  const kdsReprint = async (id: string) => {
    let status = 200;
    await handleKdsReprintKot(
      { params: { id }, on() {} } as any,
      {
        status(code: number) {
          status = code;
          return this;
        },
        json() {
          return this;
        },
      } as any,
    );
    return status;
  };
  const text = (job: Buffer) => job.toString('latin1');

  try {
    {
      unprintedKots.clearUnprintedKotsForTest();
      clearKdsAlertsForTest();
      const orderId = addOrder('ORD-PAPER');
      const first = addItem(orderId, 'Som Tam');
      const failed = await printOrderKot({ orderId });
      assert.equal(failed.status, 502);
      const [entry] = unprintedKots.listUnprintedKots();
      assert.equal(entry.reason, 'paper_out');
      assert.deepEqual(entry.item_ids, [first]);
      assert.deepEqual(entry.printer, { ip: '127.0.0.1', port: printer.port });
      assert.equal(entry.ready, false);
      assert.ok(
        recentKdsAlerts().some(
          (alert: any) =>
            alert.kind === 'kot_unprinted' &&
            alert.ref === entry.id &&
            alert.reason === 'paper_out',
        ),
        'kitchen displays learn the ticket is missing because of paper',
      );

      const second = addItem(orderId, 'Larb Moo');
      assert.equal((await printOrderKot({ orderId, items: [itemRow(second)] })).status, 502);
      const kept = unprintedKots.listUnprintedKots();
      assert.equal(kept.length, 1, 'a second failure joins the same kept ticket');
      assert.deepEqual(kept[0].item_ids, [first, second]);
      assert.equal(
        recentKdsAlerts().filter((alert: any) => alert.kind === 'kot_unprinted').length,
        1,
        'and does not raise a second warning',
      );

      await unprintedKots.checkUnprintedKotPrinters();
      assert.equal(kept[0].ready, false, 'still out of paper: nothing is offered yet');

      state.paper = 'ok';
      await unprintedKots.checkUnprintedKotPrinters();
      assert.equal(kept[0].ready, true, 'paper loaded: the kept ticket is ready to reprint');
      assert.ok(
        recentKdsAlerts().some(
          (alert: any) => alert.kind === 'kot_ready' && alert.ref === entry.id,
        ),
        'kitchen displays are asked to reprint it',
      );
      await settle(printer);
      assert.deepEqual(printer.jobs, [], 'nothing prints until someone chooses to reprint');

      assert.equal(await kdsReprint(entry.id), 200, 'staff reprint the kept ticket by hand');
      await settle(printer);
      assert.equal(printer.jobs.length, 1, 'it prints once');
      assert.ok(
        text(printer.jobs[0]).includes('Som Tam') && text(printer.jobs[0]).includes('Larb Moo'),
      );
      assert.equal(unprintedKots.listUnprintedKots().length, 0, 'and is no longer kept');
      assert.equal(await kdsReprint(entry.id), 404, 'a second tap has nothing left to print');
      await settle(printer);
      assert.equal(printer.jobs.length, 1, 'so the ticket never prints twice');
      console.log('  ✓ paper out → kept → paper loaded → offered → manual reprint, once');
    }

    {
      unprintedKots.clearUnprintedKotsForTest();
      printer.jobs.length = 0;
      const orderId = addOrder('ORD-PARTIAL');
      const printed = addItem(orderId, 'Pad Kra Pao');
      assert.equal((await printOrderKot({ orderId, items: [itemRow(printed)] })).status, 200);
      const missed = addItem(orderId, 'Tom Yum');
      state.resetNext = 3;
      const busy = await printOrderKot({ orderId, items: [itemRow(missed)] });
      assert.equal(busy.status, 502, 'a printer busy through every retry fails the ticket');
      const [entry] = unprintedKots.listUnprintedKots();
      assert.deepEqual(entry.item_ids, [missed], 'only the missed item is kept');
      assert.equal(entry.reason, 'offline');

      await unprintedKots.checkUnprintedKotPrinters();
      assert.equal(entry.ready, true, 'the printer answering again makes it ready');
      assert.equal(
        (await printOrderKot({ orderId, retryStation: entry.station })).status,
        200,
        'the POS reprint uses the same kept ticket',
      );
      await settle(printer);
      assert.equal(printer.jobs.length, 2);
      const reprint = text(printer.jobs[1]);
      assert.ok(reprint.includes('Tom Yum'), 'the reprint has the missed item');
      assert.ok(!reprint.includes('Pad Kra Pao'), 'and not the item that already printed');
      assert.equal(unprintedKots.listUnprintedKots().length, 0);
      console.log('  ✓ a reprint prints only the items that missed, never the ones already out');
    }
  } finally {
    unprintedKots.clearUnprintedKotsForTest();
    await printer.close();
    closeDatabase();
  }
}

async function main() {
  console.log('KOT print resilience');
  await networkCases();
  await kitchenTicketCases();
  console.log('KOT print resilience tests passed');
}

main()
  .then(() => {
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
