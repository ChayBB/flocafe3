import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL } from './helpers/urls';

const connectorApi = `${E2E_BASE_URL}/api/qr-cloud`;

test('a new branch connects with a one-time pairing code', async ({ page }) => {
  await page.goto(`${E2E_BASE_URL}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'));
  await setLanguage(page, 'en');
  const baseline = await page.request.get(connectorApi, {
    headers: { Authorization: `Bearer ${getE2eToken()}` },
  });
  const { config, status } = await baseline.json();
  const fresh = {
    ...config,
    enabled: false,
    mode: 'integrated',
    cloud_url: '',
    has_token: false,
    cutover_pending: false,
    paired_branch: null,
  };
  await page.route(connectorApi, (route) => route.fulfill({ json: { config: fresh, status } }));
  const codes: string[] = [];
  await page.route(`${connectorApi}/pair`, (route) => {
    const { code } = route.request().postDataJSON();
    codes.push(code);
    if (codes.length === 1)
      return route.fulfill({ status: 404, json: { code: 'pairing_code_rejected' } });
    return route.fulfill({
      json: {
        tenant_name: 'Kuk Nop',
        branch_name: 'Hat Yai',
        test: { ok: true, code: null },
        config: { ...fresh, enabled: true, has_token: true, paired_branch: 'Kuk Nop · Hat Yai' },
        status,
      },
    });
  });

  await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
  const connector = page.getByTestId('settings-qr-cloud');
  await expect(
    connector.getByRole('heading', { name: 'Connect this POS to Cloud QR Ordering' }),
  ).toBeVisible();
  await expect(connector.getByTestId('qc-url')).toHaveCount(0);
  const code = connector.getByTestId('qc-pair-code');
  const submit = connector.getByTestId('qc-pair-submit');
  await code.fill('kn7q-4m2');
  await expect(submit).toBeDisabled();
  await code.fill('kn7q-4m2x');
  await expect(code).toHaveValue('KN7Q-4M2X');
  await submit.click();
  await expect(connector.getByRole('alert')).toHaveText(
    'This code is wrong, already used, or expired. Ask for a new code.',
  );
  await code.press('Enter');
  await expect(connector.getByTestId('qc-paired-branch')).toHaveText(
    'Connected to Kuk Nop · Hat Yai',
  );
  await expect(connector.getByTestId('qc-pair-code')).toHaveCount(0);
  // A paired connector hides the manual token and private CA controls.
  await expect(connector.getByText('Enter a token or manage the CA manually')).toHaveCount(0);
  await expect(connector.getByTestId('qc-token-input')).toHaveCount(0);
  expect(codes).toEqual(['KN7Q-4M2X', 'KN7Q-4M2X']);
});

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
  await page.getByTestId('qc-enabled').click();
  await expect(dialog).toContainText('acceptance goes back to staff confirmation');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('qc-enabled')).toBeChecked();
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
        data_url:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
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
  await page.getByRole('button', { name: 'Create and show Cloud QR' }).click();
  const preview = page.getByRole('img', { name: 'Table QR-TEST · Scan to order' });
  await expect(preview).toBeVisible();
  const previewUrl = (await preview.getAttribute('src'))!;
  const textBands = await preview.evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const hasInk = (y: number, height: number) =>
      ctx
        .getImageData(0, y, canvas.width, height)
        .data.some((value, index) => index % 4 === 0 && value < 128);
    return [hasInk(0, 72), hasInk(73, canvas.height - 73)];
  });
  expect(textBands).toEqual([true, true]);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download table sticker' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('cloud-qr-QR-TEST.png');
  expect(await download.failure()).toBeNull();
  expect(await readFile(await download.path())).toEqual(
    Buffer.from(previewUrl.split(',')[1], 'base64'),
  );
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
    await connector.getByTestId('qc-manual-setup').click();
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

test('setup activation enforces permission and a fixed body', async ({ request }) => {
  const endpoint = `${connectorApi}/activate`;
  const owner = { Authorization: `Bearer ${getE2eToken()}` };
  const server = {
    Authorization: `Bearer ${getE2eToken('e2e-server', 'server@flo.local', 'server')}`,
  };
  const unauthenticated = await request.post(endpoint, { data: {} });
  expect(unauthenticated.status()).toBe(401);
  const forbidden = await request.post(endpoint, { headers: server, data: {} });
  expect(forbidden.status()).toBe(403);
  const unknownField = await request.post(endpoint, {
    headers: owner,
    data: { source_path: '../../connector.env' },
  });
  expect(unknownField.status()).toBe(400);
  expect(await unknownField.json()).toMatchObject({ code: 'legacy_request_invalid' });
});

test('a pending cutover hold needs confirmation, then tests and starts polling', async ({
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
  let cutoverPending = true;
  let enabled = false;
  let activationCount = 0;
  const current = () => ({
    ...config,
    mode: 'integrated',
    cloud_url: 'https://qr-staging.test',
    enabled,
    has_token: true,
    cutover_pending: cutoverPending,
  });
  await page.route(connectorApi, (route) => route.fulfill({ json: { config: current(), status } }));
  await page.route(`${connectorApi}/activate`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirm_legacy_stopped: true });
    activationCount += 1;
    if (activationCount === 1) return route.fulfill({ json: { ok: false, code: 'tls_failed' } });
    cutoverPending = false;
    enabled = true;
    return route.fulfill({ json: { ok: true, code: null, config: current(), status } });
  });

  await page.goto(`${E2E_BASE_URL}/settings?tab=orderflow`);
  await expect(
    page.getByRole('region', { name: 'Import settings from the legacy Connector' }),
  ).toHaveCount(0);
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
  const enabledBox = page.getByTestId('qc-enabled');
  await expect(enabledBox).toBeChecked();

  await enabledBox.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Turn off Cloud QR Ordering?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(enabledBox).toBeChecked();
  await enabledBox.click();
  await page.route(`${connectorApi}/settings`, (route) => {
    enabled = route.request().postDataJSON().enabled;
    return route.fulfill({ json: { config: current(), status } });
  });
  const turnedOff = page.waitForRequest(
    (req) => req.url() === `${connectorApi}/settings` && req.method() === 'PUT',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  expect((await turnedOff).postDataJSON()).toEqual({ enabled: false });
  await expect(enabledBox).toHaveCount(0);
});
