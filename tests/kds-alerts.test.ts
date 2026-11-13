/**
 * KDS alerts: service staff send an emergency call from the Server App, every kitchen display
 * receives it with its orders, and old alerts drop off after 30 minutes.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/kds-alerts.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kds-alerts-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-kds-alerts';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { kdsRoutes } = require('../main/routes/kds');
const { kdsAlertRoutes } = require('../main/routes/kds-alerts');
const {
  recentKdsAlerts,
  clearKdsAlertsForTest,
  addKdsAlert,
  kdsAlertsForStations,
} = require('../main/services/kds-alerts');

function seedUser(db: any, id: string, name: string, role: string) {
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, `${id}@test.local`, bcrypt.hashSync('4821', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('KDS alerts');
  console.log('='.repeat(60));
  const db = initTestDb();
  clearKdsAlertsForTest();
  const serverAuth = seedUser(db, 'server-alert', 'แมว', 'server');
  const chefAuth = seedUser(db, 'chef-alert', 'Chef', 'chef');

  const app = createApp({ '/api/kds': kdsRoutes, '/api/kds-alerts': kdsAlertRoutes });
  const { baseUrl, server } = await startServer(app);
  const send = (body: unknown, headers: Record<string, string> = serverAuth) =>
    api(baseUrl, '/api/kds-alerts', { method: 'POST', body, headers });

  try {
    const anonymous = await api(baseUrl, '/api/kds-alerts', { method: 'POST', body: {} });
    assertEqualOrThrow(anonymous.status, 401, 'an alert needs a signed-in sender');
    const chef = await send({}, chefAuth);
    assertEqualOrThrow(chef.status, 403, 'only Server App staff send alerts');
    const long = await send({ message: 'x'.repeat(121) });
    assertEqualOrThrow(long.status, 400, 'a message over 120 characters is refused');
    assertEqualOrThrow(recentKdsAlerts().length, 0, 'refused alerts are not kept');

    const sent = await send({ message: '  ไฟไหม้ที่ห้องครัว  ', table: '5' });
    assertEqualOrThrow(
      sent.status,
      201,
      `a server sends an emergency alert (${JSON.stringify(sent.data)})`,
    );
    assertEqualOrThrow(sent.data.alert.kind, 'emergency', 'the alert is an emergency');
    assertEqualOrThrow(sent.data.alert.message, 'ไฟไหม้ที่ห้องครัว', 'the message is trimmed');
    assertEqualOrThrow(sent.data.alert.table, '5', 'the table is kept');
    assertEqualOrThrow(sent.data.alert.sent_by, 'แมว', 'the sender is named');
    const bare = await send({});
    assertEqualOrThrow(bare.status, 201, 'an alert may carry no message');

    const orders = await api(baseUrl, '/api/kds/orders', { headers: chefAuth });
    assertEqualOrThrow(orders.status, 200, 'the kitchen reads its orders');
    assertEqualOrThrow(
      orders.data.alerts.map((alert: { id: string }) => alert.id).join(','),
      [sent.data.alert.id, bare.data.alert.id].join(','),
      'kitchen displays receive the alerts with their orders',
    );

    assertEqualOrThrow(
      recentKdsAlerts(Date.now() + 31 * 60 * 1000).length,
      0,
      'alerts drop off after 30 minutes',
    );
    assertOrThrow(Array.isArray(recentKdsAlerts()), 'the alert list stays readable');

    console.log('\nAll KDS alert checks passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
