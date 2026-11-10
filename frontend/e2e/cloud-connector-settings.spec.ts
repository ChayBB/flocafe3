import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL } from './helpers/urls';

const connectorApi = `${E2E_BASE_URL}/api/qr-cloud`;

test('automatic Cloud acceptance requires an explicit confirmation', async ({ page }) => {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'));
  await setLanguage(page, 'en');
  const baseline = await page.request.get(connectorApi, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
  });
  expect(baseline.ok()).toBeTruthy();
  const { config, status } = await baseline.json();
  const fixture = { ...config, enabled: true, mode: 'integrated', acceptance_mode: 'manual' };
  const updates: unknown[] = [];
  await page.route(connectorApi, (route) => route.fulfill({ json: { config: fixture, status } }));
  await page.route(`${connectorApi}/settings`, (route) => {
    const patch = route.request().postDataJSON();
    updates.push(patch);
    fixture.acceptance_mode = patch.acceptance_mode;
    return route.fulfill({ json: { config: fixture, status } });
  });
  await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
  const mode = page.getByLabel('How to accept Cloud orders', { exact: false });
  await expect(mode).toHaveValue('manual');
  await mode.selectOption('automatic');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(mode).toHaveValue('manual');
  expect(updates).toHaveLength(0);
  await mode.selectOption('automatic');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(mode).toHaveValue('automatic');
  await mode.selectOption('manual');
  await expect(mode).toHaveValue('manual');
  expect(updates).toEqual([
    { acceptance_mode: 'automatic', confirm_automatic: true },
    { acceptance_mode: 'manual', confirm_automatic: false },
  ]);
});

test('OrderFlow keeps one table sticker panel across connector status refreshes', async ({
  page,
}) => {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'));
  await setLanguage(page, 'en');
  const baseline = await page.request.get(connectorApi, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
  });
  expect(baseline.ok()).toBeTruthy();
  const { config, status } = await baseline.json();
  await page.route(connectorApi, (route) =>
    route.fulfill({
      json: {
        config: { ...config, enabled: true, mode: 'integrated' },
        status,
      },
    }),
  );
  const tableEndpoint = `${connectorApi}/table-qr`;
  await page.route(tableEndpoint, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          tables: [{ id: 'fixture-qr', number: 'QR-TEST' }],
        },
      });
    expect(route.request().postDataJSON()).toEqual({ action: 'open', table_id: 'fixture-qr' });
    return route.fulfill({
      json: {
        data_url: 'data:image/png;base64,iVBORw0KGgo=',
        expires_at: '2030-01-01T00:00:00Z',
      },
    });
  });
  await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
  const panel = page.getByRole('heading', { name: 'Cloud table QR stickers' });
  await expect(panel).toHaveCount(1);
  await page.getByRole('button', { name: 'Load POS tables' }).click();
  await page.getByLabel('POS table', { exact: true }).selectOption('fixture-qr');
  await page.waitForResponse((response) => response.url() === connectorApi && response.ok());
  await expect(panel).toHaveCount(1);
  await expect(page.getByLabel('POS table', { exact: true })).toHaveValue('fixture-qr');
  await page.getByRole('button', { name: 'Open table and show Cloud QR' }).click();
  await expect(page.getByRole('link', { name: 'Download table sticker' })).toBeVisible();
});

test('Cloud Inbox requires a table and explicit staff confirmation', async ({ page }) => {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'));
  await setLanguage(page, 'en');
  const baseline = await page.request.get(connectorApi, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
  });
  expect(baseline.ok()).toBeTruthy();
  const { config, status } = await baseline.json();
  await page.route(connectorApi, (route) =>
    route.fulfill({
      json: { config: { ...config, mode: 'integrated', enabled: true }, status },
    }),
  );
  const id = '11111111-1111-4111-8111-111111111111';
  const inbox = `${connectorApi}/inbox/orders`;
  await page.route(inbox, (route) =>
    route.fulfill({
      json: {
        events: [{ event_id: id, cloud_created_at: null }],
      },
    }),
  );
  await page.route(`${inbox}/${id}`, (route) =>
    route.fulfill({
      json: {
        table_name: 'Cloud fixture 8',
        total_satang: 4200,
        validation: null,
        lines: [
          {
            cloud_name: 'Fixture item',
            quantity: 1,
            unit_price_satang: 4200,
            note: '',
            product: { name: 'POS item', price: 42 },
          },
        ],
        tables: [{ id: 'fixture-table', number: '08' }],
      },
    }),
  );
  let posts = 0;
  await page.route(`${inbox}/${id}/accept`, (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({ table_id: 'fixture-table', confirmed: true });
    return route.fulfill({ json: { pos_order_number: 'ORD-FIXTURE' } });
  });
  await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
  await page.getByRole('button', { name: 'Load pending orders' }).click();
  await page.getByRole('button', { name: 'Review order 11111111' }).click();
  await expect(page.getByText('Cloud table Cloud fixture 8')).toBeVisible();
  const accept = page.getByRole('button', { name: 'Accept into POS' });
  await expect(accept).toBeDisabled();
  await page.getByLabel('POS table').selectOption('fixture-table');
  await accept.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('Send these items to POS table 08?', { exact: false }),
  ).toBeVisible();
  expect(posts).toBe(0);
  await dialog.getByRole('button', { name: 'Accept into POS' }).click();
  await expect(page.getByText('Accepted into POS order ORD-FIXTURE')).toBeVisible();
  expect(posts).toBe(1);
});

test('the owner can configure polling and status refresh preserves an unsaved Cloud URL', async ({
  page,
}) => {
  const ownerHeaders = { Authorization: `Bearer ${getE2eToken()}` };
  const original = await page.request.get(connectorApi, { headers: ownerHeaders });
  expect(original.ok()).toBeTruthy();
  const { config } = await original.json();
  try {
    const prepared = await page.request.put(`${connectorApi}/settings`, {
      headers: ownerHeaders,
      data: {
        enabled: false,
        mode: 'integrated',
        connection_mode: 'auto',
        poll_interval_ms: 15000,
      },
    });
    expect(prepared.ok()).toBeTruthy();
    await page.goto(`${E2E_BASE_URL}/auth/login`);
    await page.getByLabel('Email').fill('owner@flo.local');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL((url) => !url.pathname.includes('/auth/login'));
    await setLanguage(page, 'en');
    await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
    const connector = page.getByTestId('settings-qr-cloud');
    await expect(connector.getByRole('heading', { name: 'Cloud QR Ordering' })).toBeVisible();
    await expect(connector.getByText('FloCafe3', { exact: true })).toBeVisible();
    await expect(connector.getByTestId('settings-qr-ordering')).toHaveCount(0);
    const url = connector.getByTestId('qc-url');
    await url.fill('https://unsaved.example.test');
    await page.waitForResponse((response) => response.url() === connectorApi && response.ok());
    await expect(url).toHaveValue('https://unsaved.example.test');
    await expect(connector.getByTestId('qc-cloud-auth')).toHaveText('Not checked yet');
    await expect(connector.getByText('Waiting for Cloud WebSocket support')).toBeVisible();
    await connector.getByRole('radio', { name: 'HTTPS polling only' }).click();
    await expect(connector.getByRole('radio', { name: 'HTTPS polling only' })).toBeChecked();
    await connector.getByTestId('qc-interval').selectOption('30');
    await expect(connector.getByTestId('qc-interval')).toHaveValue('30');
    await expect(url).toHaveValue('https://unsaved.example.test');
    const persisted = await page.request.get(connectorApi, { headers: ownerHeaders });
    expect((await persisted.json()).config).toMatchObject({
      connection_mode: 'polling',
      poll_interval_ms: 30000,
      cloud_url: config.cloud_url,
    });
    await page.route(connectorApi, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Old app</title>' }),
    );
    await page.reload();
    await expect(connector.getByRole('heading', { name: 'Cloud QR Ordering' })).toBeVisible();
    await expect(connector.getByText('FloCafe could not load', { exact: false })).toBeVisible();
    await expect(connector.getByTestId('qc-mode-integrated')).toBeDisabled();
  } finally {
    const restored = await page.request.put(`${connectorApi}/settings`, {
      headers: ownerHeaders,
      data: config,
    });
    expect(restored.ok()).toBeTruthy();
  }
});

test('connector mutations require settings management and a permitted Origin', async ({
  request,
}) => {
  const server = getE2eToken('e2e-server', 'server@flo.local', 'server');
  const denied = await request.put(`${connectorApi}/settings`, {
    headers: { Authorization: `Bearer ${server}` },
    data: { enabled: true },
  });
  expect(denied.status()).toBe(403);
  const foreignOrigin = await request.put(`${connectorApi}/settings`, {
    headers: { Authorization: `Bearer ${getE2eToken()}`, Origin: 'https://another-pos.local' },
    data: { enabled: true },
  });
  expect(foreignOrigin.status()).toBe(403);
  expect(await foreignOrigin.json()).toMatchObject({ code: 'origin_not_allowed' });
});

test('legacy import endpoints enforce permission, confirmation and the fixed source', async ({
  request,
}) => {
  const endpoint = `${connectorApi}/legacy-import`;
  const owner = { Authorization: `Bearer ${getE2eToken()}` };
  const server = {
    Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
  };
  const unauthenticated = await request.post(`${endpoint}/commit`, { data: { confirm: true } });
  expect(unauthenticated.status()).toBe(401);
  const forbidden = await request.post(`${endpoint}/commit`, {
    headers: server,
    data: { confirm: true },
  });
  expect(forbidden.status()).toBe(403);
  const activateForbidden = await request.post(`${connectorApi}/activate`, { headers: server });
  expect(activateForbidden.status()).toBe(403);
  const traversal = await request.post(`${endpoint}/preview`, {
    headers: owner,
    data: { source_path: '../../connector.env' },
  });
  expect(traversal.status()).toBe(400);
  expect(await traversal.json()).toMatchObject({ code: 'legacy_request_invalid' });
  const unconfirmed = await request.post(`${endpoint}/commit`, { headers: owner, data: {} });
  expect(unconfirmed.status()).toBe(400);
  expect(await unconfirmed.json()).toMatchObject({ code: 'confirmation_required' });
  const stale = await request.post(`${endpoint}/commit`, {
    headers: owner,
    data: { confirm: true },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'legacy_preview_stale' });
});

test('OrderFlow imports settings and trust, then tests and starts polling in one action', async ({
  page,
}) => {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'));
  await setLanguage(page, 'en');
  const baseline = await page.request.get(connectorApi, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
  });
  expect(baseline.ok()).toBeTruthy();
  const { config, status } = await baseline.json();
  let cutoverPending = false;
  let enabled = false;
  let caApproved = false;
  let activationCount = 0;
  let previewCount = 0;
  let commitCount = 0;
  const fingerprint = Array(32).fill('AA').join(':');
  await page.route(connectorApi, (route) =>
    route.fulfill({
      json: {
        config: {
          ...config,
          cloud_url: 'https://qr-staging.test',
          enabled,
          has_token: cutoverPending || enabled,
          cutover_pending: cutoverPending,
        },
        status: {
          ...status,
          tls: {
            ...status.tls,
            configured: caApproved,
            fingerprint_sha256: caApproved ? fingerprint : null,
          },
        },
      },
    }),
  );
  await page.route(`${connectorApi}/legacy-import/preview`, (route) => {
    previewCount += 1;
    const invalid = previewCount === 1;
    return route.fulfill({
      json: {
        source_found: true,
        cloud_url: invalid ? null : 'https://qr-staging.test',
        connector_token_present: !invalid,
        poll_interval_ms: 5000,
        ca_certificate_found: true,
        ca_certificate: {
          subject: 'CN=Fixture Root',
          issuer: 'CN=Fixture Root',
          valid_from: '2026-01-01T00:00:00.000Z',
          valid_to: '2036-01-01T00:00:00.000Z',
          is_ca: true,
          fingerprint_sha256: fingerprint,
          basic_constraints: { critical: true, path_length: '1' },
        },
        ca_matches_expected: true,
        conflicts: ['configuration', 'credential'],
        validation_errors: invalid ? ['cloud_url_not_https', 'token_invalid'] : [],
        ready_for_import: !invalid,
        preview_id: invalid ? null : 'fixture-preview',
      },
    });
  });
  await page.route(`${connectorApi}/legacy-import/commit`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      preview_id: 'fixture-preview',
      confirm: true,
      replace_credential: true,
    });
    commitCount += 1;
    if (commitCount === 1) return route.fulfill({ json: {} });
    cutoverPending = true;
    return route.fulfill({ json: { imported: true, cutover_pending: true } });
  });
  await page.route(`${connectorApi}/legacy-import/ca`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      confirm: true,
      expected_fingerprint: fingerprint,
    });
    caApproved = true;
    return route.fulfill({ json: { configured: true } });
  });
  await page.route(`${connectorApi}/activate`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirm_legacy_stopped: true });
    expect(caApproved).toBe(true);
    activationCount += 1;
    if (activationCount === 1) return route.fulfill({ json: { ok: false, code: 'tls_failed' } });
    cutoverPending = false;
    enabled = true;
    return route.fulfill({
      json: {
        ok: true,
        code: null,
        config: {
          ...config,
          cloud_url: 'https://qr-staging.test',
          enabled,
          has_token: true,
          cutover_pending: false,
        },
        status,
      },
    });
  });

  await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
  await page.getByTestId('qc-setup-start').click();
  await expect(page.getByTestId('qc-test')).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'Import settings from the legacy Connector' });
  const inspect = panel.getByRole('button', { name: 'Inspect legacy files' });
  await expect(panel.getByText('Legacy configuration file found')).toBeVisible();
  await expect(panel.getByText('Token missing', { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toContainText(
    'The legacy Connector Token is missing or invalid.',
  );
  await expect(panel.getByRole('button', { name: 'Confirm import' })).toHaveCount(0);
  await inspect.click();
  await expect(panel.getByText('Token found', { exact: true })).toBeVisible();
  await expect(panel.getByText('CA certificate found')).toBeVisible();
  await expect(panel.getByText('https://qr-staging.test')).toBeVisible();
  await expect(panel.getByText(fingerprint)).toBeVisible();
  await panel.getByText('Inspect certificate', { exact: true }).click();
  await expect(panel.getByText('Maximum intermediate CA depth')).toBeVisible();
  await expect(panel.getByText('FloCafe already has a Connector credential.')).toBeVisible();
  const commit = panel.getByRole('button', { name: 'Confirm import' });
  await panel.getByRole('checkbox', { name: 'I have reviewed the settings' }).check();
  await expect(commit).toBeDisabled();
  await panel.getByRole('checkbox', { name: 'I also confirm replacing' }).check();
  await panel.getByLabel('Enter the SHA-256 fingerprint', { exact: false }).fill(fingerprint);
  await panel
    .getByRole('checkbox', { name: 'I verified the fingerprint independently', exact: false })
    .check();
  await commit.click();
  await expect(panel.getByRole('alert')).toContainText('FloCafe could not complete');
  await expect(panel.getByText('Settings imported.', { exact: false })).toHaveCount(0);
  expect(caApproved).toBe(false);
  await commit.click();
  await expect(panel.getByText('Settings imported and CA approved.')).toBeVisible();
  const verify = page.getByTestId('qc-setup-activate');
  await expect(verify).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'I verified that the legacy Connector is stopped',
      exact: false,
    })
    .check();
  await verify.click();
  await expect(verify).toBeEnabled();
  await expect(page.getByTestId('qc-enabled')).toHaveCount(0);
  await verify.click();
  await expect(page.getByTestId('qc-enabled')).toBeChecked();

  await setLanguage(page, 'th');
  try {
    await page.reload();
    const thaiPanel = page.getByRole('region', { name: 'นำเข้าการตั้งค่าจาก Connector เดิม' });
    await thaiPanel.getByRole('button', { name: 'ตรวจสอบการตั้งค่าเดิม' }).click();
    await expect(thaiPanel.getByText('พบไฟล์การตั้งค่า', { exact: true })).toBeVisible();
    await expect(thaiPanel.getByText('พบโทเคน', { exact: true })).toBeVisible();
    await expect(thaiPanel.getByText('พบใบรับรอง CA', { exact: true })).toBeVisible();
    await expect(thaiPanel.getByText('ตรวจสอบใบรับรอง', { exact: true })).toBeVisible();
    await expect(thaiPanel.getByRole('button', { name: 'ยืนยันนำเข้า', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ทดสอบการเชื่อมต่อ', exact: true })).toBeVisible();
  } finally {
    await setLanguage(page, 'en');
  }
});
