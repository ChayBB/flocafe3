/**
 * A KDS display that picks a kitchen station from its dropdown receives only the dishes whose
 * category is routed to that station, over both the WebSocket and the REST feed. A station the
 * user may not see, or one that was removed, falls back to the user's own scope instead of
 * widening it or ending the session.
 */

import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-station-selection-'));

Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startKdsServer, stopKdsServer, getKdsPort } from '../main/kds-server';
import { initDatabase, closeDatabase, getDatabase, now, projectKdsItem } from '../main/db';
import { clearRevokedTokens } from '../main/middleware/security';
import { getJWTSecret } from '../main/routes/auth';
import {
  selectedKdsStationIds,
  selectableKdsStations,
} from '../main/services/kds-station-selection';
import { buildActiveOrdersSnapshot } from '../main/services/kds';
import { WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

function itemNames(snapshot: any): string[] {
  return snapshot.orders
    .flatMap((order: any) => order.items.map((item: any) => item.product_name))
    .sort();
}

async function authOverSocket(port: number, token: string, stationId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/kds`);
  const messages: any[] = [];
  ws.on('message', (raw: WebSocket.RawData) => messages.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token, station_id: stationId }));
  const deadline = Date.now() + 10000;
  while (!messages.some((message) => message.type === 'initial_data')) {
    if (messages.some((message) => message.type === 'auth_error'))
      throw new Error(`auth_error: ${JSON.stringify(messages)}`);
    if (Date.now() > deadline) throw new Error('Timed out waiting for initial_data');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  ws.close();
  return {
    auth: messages.find((message) => message.type === 'auth_success'),
    snapshot: messages.find((message) => message.type === 'initial_data'),
  };
}

async function run() {
  clearRevokedTokens();
  initDatabase();
  await startKdsServer();
  try {
    const port = getKdsPort();
    const db = getDatabase();
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('Pass123!', 10);
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('sel-owner', 'Sel Owner', 'selowner@flo.local', ?, 'owner', 1)`).run(hash);
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('sel-bar-chef', 'Bar Chef', 'selbar@flo.local', ?, 'chef', 1)`).run(hash);

    const category = db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)');
    category.run('sel-food', 'Food', 1);
    category.run('sel-bev', 'Drinks', 2);
    const product = db.prepare(
      'INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)',
    );
    product.run('sel-rice', 'sel-food', 'Fried rice', 60);
    product.run('sel-tea', 'sel-bev', 'Iced tea', 30);

    const station = db.prepare(
      'INSERT INTO kitchen_stations (id, name, category_ids, is_active) VALUES (?, ?, ?, 1)',
    );
    station.run('sel-kitchen', 'Kitchen', JSON.stringify(['sel-food']));
    station.run('sel-bar', 'Bar', JSON.stringify(['sel-bev']));
    db.prepare(
      "INSERT INTO station_users (user_id, station_id) VALUES ('sel-bar-chef', 'sel-bar')",
    ).run();

    const addOrder = (number: string, items: Array<[string, string]>) => {
      db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
        VALUES (?, 'takeaway', 'pending', 0, 0, ?, ?)`).run(number, now(), now());
      const orderId = (
        db.prepare('SELECT id FROM orders WHERE order_number = ?').get(number) as any
      ).id;
      for (const [productId, name] of items) {
        db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
          VALUES (?, ?, ?, 0, 1, 0, 0, 0, 'pending', ?, ?)`).run(
          orderId,
          productId,
          name,
          now(),
          now(),
        );
      }
    };
    addOrder('SEL-MIXED', [
      ['sel-rice', 'Fried rice'],
      ['sel-tea', 'Iced tea'],
    ]);
    addOrder('SEL-DRINK', [['sel-tea', 'Iced tea']]);

    const ownerToken = jwt.sign(
      { userId: 'sel-owner', role: 'owner', jti: 'sel-1' },
      getJWTSecret(),
      {
        expiresIn: '1h',
      },
    );
    const chefToken = jwt.sign(
      { userId: 'sel-bar-chef', role: 'chef', jti: 'sel-2' },
      getJWTSecret(),
      {
        expiresIn: '1h',
      },
    );

    const all = await authOverSocket(port, ownerToken, '');
    assertEqualOrThrow(
      itemNames(all.snapshot).join(','),
      'Fried rice,Iced tea,Iced tea',
      'all stations shows every dish',
    );

    const kitchen = await authOverSocket(port, ownerToken, 'sel-kitchen');
    assertEqualOrThrow(
      kitchen.auth.user.stationIds.join(','),
      'sel-kitchen',
      'socket reports the picked station',
    );
    assertEqualOrThrow(
      itemNames(kitchen.snapshot).join(','),
      'Fried rice',
      'kitchen shows only its category',
    );
    assertEqualOrThrow(
      kitchen.snapshot.orders.map((order: any) => order.order_number).join(','),
      'SEL-MIXED',
      'an order with no kitchen dishes is hidden from the kitchen',
    );

    const bar = await authOverSocket(port, ownerToken, 'sel-bar');
    assertEqualOrThrow(
      itemNames(bar.snapshot).join(','),
      'Iced tea,Iced tea',
      'bar shows only drinks',
    );

    const restKitchen = JSON.parse(
      buildActiveOrdersSnapshot([], selectedKdsStationIds('sel-owner', 'sel-kitchen')!, true),
    );
    assertEqualOrThrow(
      itemNames(restKitchen).join(','),
      'Fried rice',
      'REST snapshot follows the picked station',
    );

    const chefPicksKitchen = await authOverSocket(port, chefToken, 'sel-kitchen');
    assertEqualOrThrow(
      chefPicksKitchen.auth.user.stationIds.join(','),
      'sel-bar',
      'a chef picking an unassigned station stays on their own station',
    );
    assertEqualOrThrow(
      itemNames(chefPicksKitchen.snapshot).join(','),
      'Iced tea,Iced tea',
      'the chef never sees another station through the picker',
    );
    assertEqualOrThrow(
      selectableKdsStations('sel-bar-chef')
        .map((entry) => entry.id)
        .join(','),
      'sel-bar',
      'the picker lists only the chef’s stations',
    );

    db.prepare("UPDATE kitchen_stations SET is_active = 0 WHERE id = 'sel-kitchen'").run();
    const stale = await authOverSocket(port, ownerToken, 'sel-kitchen');
    assertOrThrow(!!stale.auth, 'a removed station does not end the KDS session');
    assertEqualOrThrow(
      stale.auth.user.stationIds.length,
      0,
      'a removed station falls back to all stations',
    );

    const projected = projectKdsItem(
      {
        id: 1,
        product_name: 'ข้าวต้ม หมู/กุ้ง',
        special_instructions: 'จานเล็ก หมู',
        variant_selection: '{"id":"v1","name":"จานเล็ก","price":60,"sku":null}',
      },
      true,
    );
    assertEqualOrThrow(
      JSON.stringify(projected.variant_selection),
      JSON.stringify({ name: 'จานเล็ก' }),
      'a station-filtered KDS item keeps its size name but not its price',
    );

    console.log('kds-station-selection tests passed');
  } finally {
    await stopKdsServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
