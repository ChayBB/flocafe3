/* Test-only server bootstrap for Playwright. Keeps fixture data out of dev-server.js. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createServer } = require('node:net');
const jwt = require('jsonwebtoken');
const { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } = require('./e2e-urls.cjs');

const services = [
  { name: 'Main API', origin: E2E_BASE_URL, port: Number(new URL(E2E_BASE_URL).port) },
  { name: 'KDS', origin: E2E_KDS_BASE_URL, port: Number(new URL(E2E_KDS_BASE_URL).port) },
  {
    name: 'Server App',
    origin: E2E_SERVER_APP_BASE_URL,
    port: Number(new URL(E2E_SERVER_APP_BASE_URL).port),
  },
];
if (new Set(services.map(({ port }) => port)).size !== services.length) {
  throw new Error('E2E Main API, KDS, and Server App require distinct ports');
}

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-'));

process.env.E2E_TASK_LOCAL_PORTS = '1';
process.env.PORT = String(services[0].port);
process.env.KDS_PORT = String(services[1].port);
process.env.SERVER_APP_PORT = String(services[2].port);
process.env.JWT_SECRET = process.env.FLO_E2E_JWT_SECRET || 'e2e-test-secret';
process.env.FLO_AUTH_RATE_LIMIT_MAX = '1000';
// The whole suite shares one server and one client IP, so a production-sized limit
// here 429s the suite's own page loads instead of rate-limiting an abusive caller.
process.env.FLO_SETTINGS_READ_RATE_LIMIT_MAX = '100000';
process.env.FLO_SETTINGS_WRITE_RATE_LIMIT_MAX = '1000';
process.env.FLO_SERVER_APP_API_RATE_LIMIT_MAX = '100000';
process.env.FLO_ORDER_READ_RATE_LIMIT_MAX = '100000';
process.env.FLO_WHATSAPP_SOCKET_DISABLED = '1';
process.env.FLO_MATRIX_OFFLINE = '1';
process.env.NODE_ENV = 'test';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'e2e' } };
  }
  return originalLoad.apply(this, arguments);
};

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  initDatabase,
  getDatabase,
  closeDatabase,
  beginDatabaseShutdown,
  waitForDatabaseRequests,
  now,
} = require('../dist/main/db');
const {
  createExitCodeAwareShutdown,
  waitForHttpShutdownWork,
  isShutdownTimeout,
} = require('../dist/main/shutdown');
const { startServer, stopServer, getServerPort } = require('../dist/main/server');
const { startServerApp, stopServerApp, getServerAppPort } = require('../dist/main/server-app');
const {
  shutdown: shutdownWhatsApp,
  requestShutdown: requestWhatsAppShutdown,
} = require('../dist/main/services/whatsapp');
const { startStandaloneServers } = require('../dist/main/standalone-startup');
const flatRatePackData = require('./fixtures/synthetic-flat-rate-pack.json');
const officialIndiaPackData = require('./fixtures/legacy-tax-packs/official-india.json');
// Country/currency stay TH/THB (this fixture's configured business country)
// so getActiveCountryPack('TH') actually resolves this pack.
const testTaxPack = {
  ...flatRatePackData,
  id: 'test-th-pack',
  country: 'TH',
  currency: 'THB',
  publisher: 'FreeOpenSourcePOS',
};

// BUNDLED_COUNTRY_PACKS (main/tax-packs/bundled.ts) only ships the generic
// pack — real country packs (e.g. Thailand, India) are separately-published
// "official" packs that must be explicitly installed and activated, same as
// production's real activation route (main/routes/tax-packs.ts) and the Node
// test suite's installAndActivateTestTaxPack (tests/helpers/test-setup.ts).
// Without this, getActiveCountryPack('TH') matches the generic pack's '*'
// wildcard row before ever falling back to bundled data, and this fixture's
// 'standard' category resolves to nothing — checkout fails with "no tax
// rules apply to category standard for business type restaurant" instead of
// computing tax.
function installAndActivateTaxPack(db, pack) {
  const installedAt = now();
  const versionId = `${pack.id}@${pack.version}`;
  const packJson = JSON.stringify(pack);
  const digest = crypto.createHash('sha256').update(packJson).digest('hex');

  db.prepare(`
    INSERT INTO country_packs (
      id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      publisher = excluded.publisher,
      country = excluded.country,
      jurisdiction = excluded.jurisdiction,
      active_version_id = excluded.active_version_id,
      status = 'active',
      updated_at = excluded.updated_at
  `).run(
    pack.id,
    pack.publisher,
    pack.country,
    pack.jurisdiction,
    versionId,
    installedAt,
    installedAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO country_pack_versions (
      id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
      effective_from, effective_to, min_flo_version, published_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
  `).run(
    versionId,
    pack.id,
    pack.version,
    pack.schemaVersion,
    JSON.stringify({
      id: pack.id,
      publisher: pack.publisher,
      country: pack.country,
      jurisdiction: pack.jurisdiction,
      version: pack.version,
      publishedAt: pack.publishedAt,
    }),
    packJson,
    digest,
    pack.effectiveFrom,
    pack.effectiveTo || null,
    pack.minFloVersion,
    pack.publishedAt,
    installedAt,
  );

  const insertCategory = db.prepare(`
    INSERT OR REPLACE INTO tax_categories (
      id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const category of pack.categories) {
    insertCategory.run(
      `${versionId}:category:${category.id}`,
      versionId,
      category.id,
      category.label,
      category.defaultBehavior || null,
      JSON.stringify(category),
      installedAt,
    );
  }

  const insertRule = db.prepare(`
    INSERT OR REPLACE INTO tax_rules (
      id, pack_version_id, rule_id, label, calculation_type, rate, amount,
      applies_per, base_rule_ids, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of pack.rules) {
    insertRule.run(
      `${versionId}:rule:${rule.id}`,
      versionId,
      rule.id,
      rule.label,
      rule.type,
      rule.rate || null,
      rule.amount || null,
      rule.appliesPer || null,
      JSON.stringify(rule.baseRuleIds || []),
      JSON.stringify(rule),
      installedAt,
    );
  }
}
const { startKdsServer, stopKdsServer, getKdsPort } = require('../dist/main/kds-server');

function assertRequiredPortAvailable(port, service) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      probe.close();
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`E2E ${service} port ${port} is unavailable`));
      } else {
        reject(error);
      }
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve());
    });
  });
}

async function assertFixtureAuthentication({ name, origin }, token) {
  try {
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { user } = await response.json();
    if (user?.id !== 'e2e-manager') throw new Error('unexpected fixture user');
  } catch (error) {
    throw new Error(`E2E ${name} authentication check failed at ${origin}: ${error.message}`);
  }
}

function seedUser(id, email, role) {
  getDatabase()
    .prepare(
      'INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    )
    .run(id, `E2E ${role}`, email, bcrypt.hashSync('E2ePass123!', 10), role, now(), now());
}

function seedPosFixture() {
  const db = getDatabase();
  const createdAt = now();
  for (const [key, value] of [
    ['country', 'TH'],
    ['currency', 'THB'],
    ['timezone', 'Asia/Bangkok'],
    ['billing_type', 'prepaid'],
    ['business_type', 'restaurant'],
    ['tables_required', 'false'],
    // Stays enabled because the blocklist UI is gated on it. The live session is
    // suppressed separately via FLO_WHATSAPP_SOCKET_DISABLED.
    ['whatsapp_enabled', 'true'],
    // Tax defaults off (migration 40) until explicitly enabled — this fixture's
    // product carries a real tax_category_id expecting real tax, so it must
    // turn taxes on itself rather than rely on a global default.
    ['taxes_enabled', 'true'],
  ]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      key,
      value,
      createdAt,
    );
  }
  installAndActivateTaxPack(db, testTaxPack);
  installAndActivateTaxPack(db, officialIndiaPackData);
  db.prepare(
    'INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  ).run('e2e-category', 'E2E Menu', 1, createdAt, createdAt);
  db.prepare(
    `INSERT INTO products (
       id, category_id, name, price, tax_type, tax_category_id, tax_behavior,
       cb_percent, track_inventory, stock_quantity, is_active, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    'e2e-product',
    'e2e-category',
    'E2E Coffee',
    60,
    'none',
    'standard',
    'exclusive',
    0,
    0,
    999,
    1,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO inventory_movements (
       product_id, quantity_delta, movement_type, reference_type, reason, actor_user_id, stock_after, created_at
     ) VALUES (?, ?, 'adjustment', 'opening_balance', 'Initial fixture balance', 'e2e-owner', ?, ?)`,
  ).run('e2e-product', 999, 999, createdAt);
  db.prepare(
    `INSERT OR IGNORE INTO customers (
       id, name, phone, country_code, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run('e2e-customer', 'E2E Guest', '+66800000001', '+66', createdAt, createdAt);
}

let exitRequested = false;
let shutdownRequested = false;
const requestStop = createExitCodeAwareShutdown(
  async () => {
    let cleanupFailed = false;
    let databaseBlocked = false;
    try {
      await stopServerApp();
    } catch (error) {
      cleanupFailed = true;
      databaseBlocked = true;
      console.error('[E2E] Server App cleanup failed:', error);
      if (isShutdownTimeout(error)) throw error;
    }
    try {
      await stopServer();
    } catch (error) {
      cleanupFailed = true;
      databaseBlocked = true;
      console.error('[E2E] Main server cleanup failed:', error);
      if (isShutdownTimeout(error)) throw error;
    }
    try {
      await stopKdsServer();
    } catch (error) {
      cleanupFailed = true;
      databaseBlocked = true;
      console.error('[E2E] KDS server cleanup failed:', error);
      if (isShutdownTimeout(error)) throw error;
    }
    try {
      await shutdownWhatsApp();
    } catch (error) {
      cleanupFailed = true;
      databaseBlocked = true;
      console.error('[E2E] WhatsApp cleanup failed:', error);
      if (isShutdownTimeout(error)) throw error;
    }
    try {
      await waitForHttpShutdownWork();
    } catch (error) {
      cleanupFailed = true;
      databaseBlocked = true;
      console.error('[E2E] HTTP handler cleanup failed:', error);
      if (isShutdownTimeout(error)) throw error;
    }
    try {
      beginDatabaseShutdown();
      await waitForDatabaseRequests();
    } catch (error) {
      cleanupFailed = true;
      databaseBlocked = true;
      console.error('[E2E] Database request drain failed:', error);
      if (isShutdownTimeout(error)) throw error;
    }
    if (!databaseBlocked) {
      try {
        closeDatabase();
      } catch (error) {
        cleanupFailed = true;
        console.error('[E2E] Database cleanup failed:', error);
      }
    }
    Module._load = originalLoad;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      cleanupFailed = true;
      console.error('[E2E] Fixture cleanup failed:', error);
    }
    return cleanupFailed ? 1 : 0;
  },
  {
    onShutdownRequested: requestWhatsAppShutdown,
    onFatalTimeout: () => process.exit(1),
  },
);

async function stop(exitCode = 0) {
  shutdownRequested = true;
  const finalExitCode = await requestStop(exitCode);
  if (!exitRequested) {
    exitRequested = true;
    process.exit(finalExitCode);
  }
}

(async () => {
  for (const { name, port } of services) await assertRequiredPortAvailable(port, name);
  await startStandaloneServers({
    initializeDatabase: initDatabase,
    prepare: () => {
      seedUser('e2e-owner', 'owner@flo.local', 'owner');
      seedUser('e2e-manager', 'manager@flo.local', 'manager');
      seedUser('e2e-server', 'server@flo.local', 'server');
      seedPosFixture();
    },
    startServer,
    startKdsServer,
    startServerApp,
    isShutdownRequested: () => shutdownRequested,
  });
  const actualPorts = [getServerPort(), getKdsPort(), getServerAppPort()];
  for (const [index, { name, port }] of services.entries()) {
    if (actualPorts[index] !== port) {
      throw new Error(`E2E ${name} port mismatch: expected ${port}, got ${actualPorts[index]}`);
    }
  }
  const token = jwt.sign(
    { userId: 'e2e-manager', email: 'manager@flo.local', role: 'manager' },
    process.env.JWT_SECRET,
    { expiresIn: '1m' },
  );
  await Promise.all(services.map((service) => assertFixtureAuthentication(service, token)));
  console.log('[E2E] Main, KDS, and Server App servers ready');
})().catch((error) => {
  console.error(error);
  stop(1);
});

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
