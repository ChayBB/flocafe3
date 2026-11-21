/**
 * Cloud QR pairing: a one-time code from the Cloud becomes this POS's connector token, the
 * production Cloud is used by default, and polling starts only after a successful test.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/qr-cloud-pairing.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalLoad = Module._load;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-pairing-test-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => tempRoot, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
        decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8'),
      },
    };
  return originalLoad.apply(this, arguments as never);
};
process.env.FLO_QR_CLOUD_DIR = path.join(tempRoot, 'qr-cloud');

const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { initDatabase, closeDatabase, getDatabase, getSettingValue, upsertSettings } = require('../main/db');
const { assertOrThrow, assertEqualOrThrow, getResults, resetCounters } = require('./helpers/test-setup');
const config = require('../main/services/qr-cloud/config');
const connector = require('../main/services/qr-cloud/connector');
const { QrCloudClientError } = require('../main/services/qr-cloud/client');
const pairing = require('../main/services/qr-cloud/pairing');

const TOKEN = 'paired-connector-token-0123456789abcdef';
const ACTOR = 'pairing-owner';

async function rejects(promise: Promise<unknown>, code: string, label: string) {
  try {
    await promise;
  } catch (error: any) {
    assertEqualOrThrow(error?.code, code, label);
    return;
  }
  throw new Error(`${label}: expected ${code} but it resolved`);
}

function reset() {
  config.clearConnectorToken();
  upsertSettings({
    [config.QR_CLOUD_SETTING_KEYS.enabled]: '0',
    [config.QR_CLOUD_SETTING_KEYS.cloudUrl]: '',
    [config.QR_CLOUD_SETTING_KEYS.cutoverPending]: '0',
    [config.QR_CLOUD_SETTING_KEYS.pairedBranch]: '',
  });
  connector.startQrCloudConnector();
}

async function main() {
  resetCounters();
  initDatabase();
  let pollSucceeds = true;
  connector.__setFetchEventsForTests(async () => {
    if (!pollSucceeds) throw new QrCloudClientError('auth_failed', 'HTTP 401');
    return { events: [], status: 200, latencyMs: 1 };
  });

  const originalRequest = https.request;
  const sent: { path: string; host: string; auth: unknown; body: string }[] = [];
  let reply = { status: 200, body: { connector_token: TOKEN, installation_id: 'i', tenant_name: 'Kuk Nop', branch_name: 'Hat Yai' } as unknown };
  https.request = (options: any, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as any;
    request.end = (body: string) => {
      sent.push({ path: options.path, host: options.hostname, auth: options.headers.Authorization, body });
      const response = new PassThrough() as any;
      response.statusCode = reply.status;
      callback(response);
      response.end(JSON.stringify(reply.body));
    };
    request.destroy = () => {};
    return request;
  };

  try {
    await rejects(pairing.pairQrCloud(ACTOR, 'KN7Q-4M2O'), 'pairing_code_invalid', 'look-alike characters are refused locally');
    assertEqualOrThrow(sent.length, 0, 'an invalid code never reaches the Cloud');

    const paired = await pairing.pairQrCloud(ACTOR, ' kn7q 4m2x ');
    const current = config.readConfig();
    assertEqualOrThrow(sent[0].host, 'qr-ordering.accesscam.org', 'an unconfigured POS pairs with the production Cloud');
    assertEqualOrThrow(sent[0].path, '/api/v1/connectors/pair', 'the pairing endpoint is called');
    assertEqualOrThrow(sent[0].auth, undefined, 'pairing sends no bearer token');
    assertEqualOrThrow(JSON.parse(sent[0].body).code, 'KN7Q4M2X', 'the code is sent normalized');
    assertEqualOrThrow(config.readConnectorSetting(), TOKEN, 'the redeemed token is stored');
    assertEqualOrThrow(current.cloudUrl, pairing.DEFAULT_QR_CLOUD_URL, 'the production Cloud URL is saved');
    assertOrThrow(current.enabled && current.mode === 'integrated', 'a successful test starts polling');
    assertEqualOrThrow(getSettingValue(config.QR_CLOUD_SETTING_KEYS.pairedBranch), 'Kuk Nop · Hat Yai', 'the paired branch is remembered');
    assertOrThrow(paired.test.ok && paired.branch_name === 'Hat Yai', 'the result names the paired branch');
    const audit = getDatabase()
      .prepare("SELECT user_id FROM auth_audit_log WHERE event_type = 'qr_cloud_paired'")
      .all();
    assertEqualOrThrow(audit.length, 1, 'pairing is audited');
    assertEqualOrThrow(audit[0].user_id, ACTOR, 'the audit names the actor');

    connector.revokeQrCloudToken();
    assertEqualOrThrow(getSettingValue(config.QR_CLOUD_SETTING_KEYS.pairedBranch), '', 'removing the token forgets the branch');

    reset();
    upsertSettings({ [config.QR_CLOUD_SETTING_KEYS.cloudUrl]: 'https://order.example.org' });
    await pairing.pairQrCloud(ACTOR, 'KN7Q4M2X');
    assertEqualOrThrow(sent.at(-1)!.host, 'order.example.org', 'a configured production Cloud is kept');

    reset();
    upsertSettings({
      [config.QR_CLOUD_SETTING_KEYS.cloudUrl]: 'https://qr-staging.test',
      [config.QR_CLOUD_SETTING_KEYS.cutoverPending]: '1',
    });
    pollSucceeds = false;
    const untested = await pairing.pairQrCloud(ACTOR, 'KN7Q4M2X');
    assertEqualOrThrow(sent.at(-1)!.host, 'qr-ordering.accesscam.org', 'the staging URL is replaced by production');
    assertOrThrow(!untested.test.ok && !config.readConfig().enabled, 'a failed test leaves polling off');
    assertOrThrow(config.hasConnectorToken() && !config.readConfig().cutoverPending, 'a failed test still keeps the pairing');
    pollSucceeds = true;

    reset();
    reply = { status: 404, body: { error: 'pairing code not found or expired' } };
    await rejects(pairing.pairQrCloud(ACTOR, 'KN7Q4M2X'), 'pairing_code_rejected', 'a spent or expired code is reported');
    reply = { status: 429, body: { error: 'too many pairing attempts' } };
    await rejects(pairing.pairQrCloud(ACTOR, 'KN7Q4M2X'), 'pairing_rate_limited', 'Cloud throttling is reported');
    reply = { status: 200, body: { tenant_name: 'Kuk Nop', branch_name: 'Hat Yai' } };
    await rejects(pairing.pairQrCloud(ACTOR, 'KN7Q4M2X'), 'bad_response', 'a reply without a token is refused');
    assertOrThrow(!config.hasConnectorToken() && !config.readConfig().cloudUrl, 'failed pairing stores nothing');
  } finally {
    https.request = originalRequest;
    connector.__setFetchEventsForTests(null);
    connector.stopQrCloudConnector();
    require('../main/services/qr-cloud/inbox').closeInbox();
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\nQR cloud pairing: ${results.passed}/${results.total} checks passed.`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
