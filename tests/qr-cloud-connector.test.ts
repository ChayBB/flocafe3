/**
 * Integrated Cloud QR Ordering connector: configuration, inbox durability, lifecycle, TLS trust
 * and the guarantees that make it safe (no POS writes, no Cloud ACK, no secret exposure).
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
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => tempRoot, getVersion: () => 'test' } };
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
    'cloud_url_invalid',
    'whitespace in token',
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

  console.log('--- 8. Error history clearing keeps events ---');
  const totalBeforeClear = inbox.inboxSummary().total;
  connector.clearQrCloudErrorHistory();
  assertEqualOrThrow(
    inbox.inboxSummary().total,
    totalBeforeClear,
    'clearing errors keeps every event',
  );
  assertEqualOrThrow(connector.getQrCloudStatus().last_error, null, 'last error is cleared');

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
