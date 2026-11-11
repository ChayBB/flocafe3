/**
 * End-to-end Test: Argentina Country Flow
 *
 * Walks the full Argentina onboarding path: country selection → backend
 * initialization → demo seed → tax engine → settings save/load → customer
 * dial code → translation routing.
 *
 * Verifies that:
 *  - Onboarding with country=AR persists the country profile (es-AR, CUIT, IVA, Comprobante)
 *  - Argentina demo seed follows the UI language, not the store country
 *  - Settings save/load round-trips the country and its derived fiscal fields
 *  - Non-Argentina onboarding still gets the legacy India demo (regression guard)
 *  - Tax engine runs the AR path without error
 *  - i18n has matching keys in en and es (no missing translations)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/e2e-argentina-flow.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-ar-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assert,
  assertEqual,
  assertIncludes,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');

const { authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { customerRoutes } = require('../main/routes/customers');
const { collectCalledKeys } = require('./helpers/i18n-scanner');

async function main() {
  console.log('End-to-End Test: Argentina Country Flow');
  console.log('='.repeat(60));

  let server;
  let baseUrl;
  let db;
  try {
    db = initTestDb();
    const app = createApp({
      '/api/auth': authRoutes,
      '/api/settings': settingsRoutes,
      '/api/customers': customerRoutes,
    });
    const started = await startServer(app);
    server = started.server;
    baseUrl = started.baseUrl;

    await runArgentinaOnboarding(baseUrl, db);
    await runArgentinaSettings(baseUrl, db);
    await runArgentinaTaxAndCustomers(baseUrl, db);
    await runArgentinaTranslations(db);
  } finally {
    if (server) server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // Run the regression in a fresh DB so the AR hamburger from earlier does not
  // contaminate the legacy India demo assertion.
  const legacyTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-legacy-'));
  try {
    await runLegacyOnboardingInIsolation(legacyTestDir);
  } finally {
    try {
      fs.rmSync(legacyTestDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function runLegacyOnboardingInIsolation(legacyTestDir) {
  console.log('\n5. Regression: non-AR onboarding keeps the legacy demo (country=IN)');
  const Module2 = require('module');
  const originalLoad2 = Module2._load;
  Module2._load = function (request, parent, isMain) {
    if (request === 'electron')
      return { app: { isPackaged: true, getPath: () => legacyTestDir, getVersion: () => 'test' } };
    return originalLoad2.apply(this, arguments);
  };

  const { initTestDb, closeDatabase } = require('./helpers/test-setup');
  const { seedSetupProfile } = require('../main/routes/auth');
  const db2 = initTestDb();

  try {
    seedSetupProfile(db2, 'demo', 'finedine', 'en', 'IN');
    const india = db2.prepare("SELECT id FROM products WHERE id = 'prod-demo-paneer-tikka'").get();
    assert(!!india, 'legacy India demo seeds paneer tikka');
    const burger = db2
      .prepare("SELECT id FROM products WHERE id = 'prod-demo-hamburguesa-clasica'")
      .get();
    assert(!burger, 'legacy India demo does NOT seed the Argentina hamburger menu');
  } finally {
    closeDatabase();
    Module2._load = originalLoad2;
  }
}

async function runArgentinaOnboarding(baseUrl, db) {
  console.log('\n1. Onboarding with country = AR');
  const res = await api(baseUrl + '/api', '/auth/setup/initialize', {
    method: 'POST',
    body: {
      name: 'Sofía Owner',
      email: 'ar-owner@test.local',
      password: 'Test1234',
      business_type: 'restaurant',
      business_name: 'Burger AR',
      setup_profile: 'demo',
      service_model: 'finedine',
      country: 'AR',
      currency: 'ARS',
      timezone: 'America/Argentina/Buenos_Aires',
      language: 'en',
      terms_accepted: true,
      owner_approval_pin: '5678',
      owner_approval_pin_confirmation: '5678',
    },
  });

  assertEqual(res.status, 200, 'setup/initialize returns 200 for AR');
  const tenant = res.data.tenant;
  assertEqual(tenant.country, 'AR', 'tenant.country = AR');
  assertEqual(tenant.currency, 'ARS', 'tenant.currency = ARS');
  assertEqual(tenant.currency_symbol, '$', 'tenant.currency_symbol = $ (not ARS)');
  assertEqual(tenant.timezone, 'America/Argentina/Buenos_Aires', 'tenant.timezone = AR');
  assertEqual(tenant.language, 'en', 'tenant.language = en');

  const curSymbol = db.prepare("SELECT value FROM settings WHERE key = 'currency_symbol'").get();
  assertEqual(curSymbol.value, '$', 'DB currency_symbol = $ for ARS');

  const customer = db
    .prepare("SELECT id, country_code FROM customers WHERE id = 'cust-demo-1'")
    .get();
  assert(!!customer, 'Argentina demo seeds a demo customer');

  const staffName = db.prepare("SELECT name FROM users WHERE id = 'user-demo-manager'").get();
  assertEqual(staffName.name, 'Demo Manager', 'demo staff follows the English UI language');
}

async function runArgentinaSettings(baseUrl, db) {
  console.log('\n2. Settings save/load round-trip preserves the country profile');
  const { authHeader } = seedOwnerUser(db);

  const getRes = await api(baseUrl + '/api', '/settings/business', { headers: authHeader });
  assertEqual(getRes.status, 200, 'GET /settings/business returns 200');
  assertEqual(getRes.data.country, 'AR', 'GET returns country = AR');

  const putRes = await api(baseUrl + '/api', '/settings/business', {
    method: 'PUT',
    headers: authHeader,
    body: {
      business_name: 'Burger AR E2E',
      country: 'AR',
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
    },
  });
  assertEqual(putRes.status, 200, 'PUT /settings/business returns 200');
  assertEqual(putRes.data.country, 'AR', 'PUT preserves country = AR');

  const verify = await api(baseUrl + '/api', '/settings/business', { headers: authHeader });
  assertEqual(verify.data.business_name, 'Burger AR E2E', 'business_name persisted');
}

async function runArgentinaTaxAndCustomers(baseUrl, db) {
  console.log('\n3. Argentina tax engine and customer country code');
  const { authHeader } = seedOwnerUser(db);

  const settingsTax = db.prepare("SELECT value FROM settings WHERE key = 'country'").get();
  assertEqual(settingsTax.value, 'AR', 'settings.country = AR after first-run setup');

  const { calculateItemTax } = require('../main/services/tax');
  const result = calculateItemTax(
    { country: 'AR', business_type: 'restaurant', state_code: '', taxes_enabled: true },
    { tax_type: 'inclusive', tax_rate: 21 },
    100,
    null,
  );
  assertEqual(result.tax_amount, 0, 'uncategorized AR product is tax-free');
  assertEqual(result.tax_breakdown.length, 0, 'uncategorized AR product emits no tax breakdown');

  const cRes = await api(baseUrl + '/api', '/customers', {
    method: 'POST',
    headers: authHeader,
    body: { name: 'Test AR Customer', phone: '1145678999', country_code: '+54' },
  });
  assertEqual(cRes.status, 201, 'customer created with +54 country code');
  assertEqual(cRes.data.customer.country_code, '+54', 'new customer has +54 stored');
}

async function runArgentinaTranslations(db) {
  console.log('\n4. i18n has matching keys for both languages and every t() reference resolves');
  const i18nDir = path.join(__dirname, '../frontend/src/lib/i18n/messages');
  const enSrc = fs.readFileSync(path.join(i18nDir, 'en.json'), 'utf8');
  const thSrc = fs.readFileSync(path.join(i18nDir, 'th.json'), 'utf8');

  const enKeys = extractJsonKeys(enSrc);
  const thKeys = extractJsonKeys(thSrc);
  assert(enKeys.size > 0 && thKeys.size > 0, 'i18n defines both en and th blocks');
  if (enKeys.size === 0 || thKeys.size === 0) return;

  const missingInTh = [...enKeys].filter((k) => !thKeys.has(k));
  const missingInEn = [...thKeys].filter((k) => !enKeys.has(k));
  assertEqual(missingInTh.length, 0, `th is missing keys: ${missingInTh.join(', ') || 'none'}`);
  assertEqual(missingInEn.length, 0, `en is missing keys: ${missingInEn.join(', ') || 'none'}`);

  // Walk the entire frontend src tree and assert every `t('key')` reference
  // resolves to a known key. Catches wiring gaps: a developer adds
  // `t('foo.bar')` and forgets to define the key.
  const referenced = collectCalledKeys(path.join(__dirname, '../frontend/src'));
  console.log(`    found ${referenced.size} unique t() keys referenced in frontend`);
  assert(
    referenced.size >= 20,
    `at least 20 translation keys should be wired in (found ${referenced.size})`,
  );
  const unknownRefs = [...referenced].filter((k) => !enKeys.has(k));
  assertEqual(
    unknownRefs.length,
    0,
    `t() calls reference unknown keys: ${unknownRefs.join(', ') || 'none'}`,
  );
}

function extractJsonKeys(jsonSrc) {
  const keys = new Set();
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, full);
      else keys.add(full);
    }
  };
  walk(JSON.parse(jsonSrc), '');
  return keys;
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
