const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('../frontend/node_modules/playwright');
const labels = require('../frontend/src/lib/i18n/messages/th.json').serverApp;

const bundle = path.resolve(process.argv[2]);
const output = process.argv[3];
const delay = Number(process.env.ORDERING_API_DELAY_MS || 200);
const table = '11111111-1111-4111-8111-111111111111';
const item = '22222222-2222-4222-8222-222222222222';
const token = 'a'.repeat(43);
const renewedToken = 'b'.repeat(43);
const samples = [];
let requests = [];
let scenario = 'ok';
let presentationReads = 0;
let awaitingPayment = false;
let orderWrites = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    requests.push({
      path: url.pathname,
      at: performance.now(),
      authorization: req.headers.authorization,
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/orders' && req.method === 'POST') {
      orderWrites++;
      if (scenario === 'uncertain') {
        awaitingPayment = true;
        if (orderWrites === 1) res.writeHead(503).end('{}');
        else
          res.end(
            JSON.stringify({ order_id: '33333333-3333-4333-8333-333333333333', replayed: true }),
          );
        return;
      }
      res.writeHead(409).end(JSON.stringify({ code: 'bill_awaiting_payment' }));
      return;
    }
    if (url.pathname.endsWith('/session') && (scenario === 'closed' || scenario === 'expired')) {
      res.writeHead(409).end('{}');
      return;
    }
    if (url.pathname.endsWith('/session') && scenario === 'limited') {
      res.writeHead(429).end('{}');
      return;
    }
    if (
      url.pathname.endsWith('/menu') &&
      req.headers.authorization &&
      (scenario === 'expired' ||
        (scenario === 'renewed' && req.headers.authorization === `Bearer ${token}`))
    ) {
      res.writeHead(401).end('{}');
      return;
    }
    if (
      url.pathname.endsWith('/menu') &&
      !req.headers.authorization &&
      scenario === 'preview-failed'
    ) {
      res.writeHead(502).end('{}');
      return;
    }
    const data = url.pathname.endsWith('/session')
      ? { table_token: scenario === 'renewed' ? renewedToken : token }
      : url.pathname.endsWith('/menu')
        ? {
            items: [{ id: item, name: 'Benchmark Coffee', price_satang: 5000, category: 'Drinks' }],
          }
        : { orders: [], bill_awaiting_payment: awaitingPayment };
    res.end(JSON.stringify(data));
    return;
  }
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<html lang="th"><div id="root"></div><script type="module" src="/order.js"></script></html>',
    );
    return;
  }
  if (url.pathname.endsWith('/menu-presentation.json')) {
    presentationReads++;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(JSON.stringify({ categories: [], products: [], popular: [] }));
    return;
  }
  const file = path.resolve(bundle, '.' + url.pathname);
  if (!file.startsWith(bundle + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader('Content-Type', 'text/javascript');
  res.end(fs.readFileSync(file));
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    chromiumSandbox: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  try {
    for (let index = 0; index < 7; index++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (
            !document
              .querySelector('[data-testid="pos-product-grid"]')
              ?.textContent.includes('Benchmark Coffee')
          )
            return;
          window.__orderingMenuVisibleMs = performance.now();
          observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      requests = [];
      await page.goto(`http://127.0.0.1:${server.address().port}/#table=${table}`);
      await page
        .getByTestId('pos-product-grid')
        .getByText('Benchmark Coffee', { exact: true })
        .first()
        .waitFor();
      samples.push({
        menuVisibleMs: Math.round(await page.evaluate(() => window.__orderingMenuVisibleMs)),
        sessionToMenuRequestMs: Math.round(
          requests.find((request) => request.path.endsWith('/menu')).at -
            requests.find((request) => request.path.endsWith('/session')).at,
        ),
        errors,
      });
      if (errors.length) throw new Error(errors.join('\n'));
      await context.close();
    }
    const sorted = samples.map((sample) => sample.menuVisibleMs).sort((a, b) => a - b);
    const checks = [];
    if (process.argv.includes('--verify')) {
      assert(
        samples.every((sample) => Math.abs(sample.sessionToMenuRequestMs) < delay / 2),
        'menu and new session must start together',
      );
      checks.push('new session and menu load in parallel');
      for (const current of [
        'ok',
        'closed',
        'limited',
        'expired',
        'renewed',
        'preview-failed',
        'token-only',
      ]) {
        scenario = current;
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        if (current === 'expired' || current === 'renewed') {
          await context.addInitScript(
            ({ table, token }) => sessionStorage.setItem(`flocafe-table-session:${table}`, token),
            { table, token },
          );
        }
        requests = [];
        presentationReads = 0;
        const hash = current === 'token-only' ? `table_token=${token}` : `table=${table}`;
        await page.goto(`http://127.0.0.1:${server.address().port}/#${hash}`);
        if (current === 'limited') {
          await page.getByRole('status').filter({ hasText: 'มีอุปกรณ์ใช้โต๊ะนี้ครบแล้ว' }).waitFor();
          assert.equal(await page.getByTestId('pos-product-grid').count(), 0);
        } else {
          await page
            .getByTestId('pos-product-grid')
            .getByText('Benchmark Coffee', { exact: true })
            .first()
            .waitFor();
          if (current === 'closed' || current === 'expired') {
            await page.getByRole('status').filter({ hasText: 'QR โต๊ะนี้ไม่พร้อมใช้งาน' }).waitFor();
            assert.equal(
              await page.getByRole('button', { name: labels.currentTicket, exact: true }).count(),
              0,
            );
          }
          if (current === 'renewed') {
            await page.getByRole('button', { name: labels.currentTicket, exact: true }).waitFor();
            assert.equal(
              await page.evaluate(
                (key) => sessionStorage.getItem(`flocafe-table-session:${key}`),
                table,
              ),
              renewedToken,
            );
            assert.equal(requests.filter((request) => request.path.endsWith('/session')).length, 1);
          }
          if (current === 'preview-failed' || current === 'token-only') {
            assert(
              requests.some(
                (request) =>
                  request.path.endsWith('/menu') && request.authorization === `Bearer ${token}`,
              ),
            );
          }
          if (current === 'ok') {
            assert.equal(presentationReads, 1);
            await page.reload();
            await page
              .getByTestId('pos-product-grid')
              .getByText('Benchmark Coffee', { exact: true })
              .first()
              .waitFor();
            assert.equal(presentationReads, 1, 'immutable presentation should be reused on reload');
          }
        }
        assert.deepEqual(errors, []);
        checks.push(current);
        await context.close();
      }
    }
    if (process.argv.includes('--verify')) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      scenario = 'ok';
      awaitingPayment = true;
      await page.goto(`http://127.0.0.1:${server.address().port}/#table=${table}`);
      await page
        .getByRole('alert')
        .filter({ hasText: labels.tableAwaitingPaymentLocked })
        .waitFor();
      const product = page
        .getByTestId('pos-product-grid')
        .getByText('Benchmark Coffee', { exact: true })
        .first();
      await product.waitFor();
      await page.getByRole('button', { name: labels.currentTicket, exact: true }).click();
      await page.getByRole('button', { name: labels.sendToKitchen, exact: true }).waitFor();
      assert(
        await page.getByRole('button', { name: labels.sendToKitchen, exact: true }).isDisabled(),
      );
      assert.equal(orderWrites, 0, 'an already locked table submits nothing');
      awaitingPayment = false;
      await page.reload();
      await product.waitFor();
      await product.click();
      await page.getByRole('button', { name: labels.currentTicket, exact: true }).click();
      const submit = page.getByRole('button', { name: labels.sendToKitchen, exact: true });
      await submit.waitFor();
      page.once('dialog', (dialog) => dialog.accept());
      await submit.click();
      await page
        .getByRole('alert')
        .filter({ hasText: labels.tableAwaitingPaymentLocked })
        .waitFor();
      assert(await submit.isDisabled());
      assert.equal(orderWrites, 1, 'a raced payment lock sends exactly one rejected attempt');
      assert.equal(
        await page.getByRole('dialog').getByText('Benchmark Coffee', { exact: true }).count(),
        1,
        'a payment hold preserves the draft',
      );
      const storedAttempts = await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) => key.startsWith('flocafe-order:')),
      );
      assert.deepEqual(storedAttempts, [], 'a known rejected attempt is cleared');
      await context.close();
      checks.push('payment hold blocks sending and preserves rejected drafts');
      const retryContext = await browser.newContext();
      const retryPage = await retryContext.newPage();
      retryPage.setDefaultTimeout(10000);
      scenario = 'uncertain';
      awaitingPayment = false;
      orderWrites = 0;
      await retryPage.goto(`http://127.0.0.1:${server.address().port}/#table=${table}`);
      await retryPage
        .getByTestId('pos-product-grid')
        .getByText('Benchmark Coffee', { exact: true })
        .first()
        .click();
      await retryPage.getByRole('button', { name: labels.currentTicket, exact: true }).click();
      retryPage.once('dialog', (dialog) => dialog.accept());
      await retryPage.getByRole('button', { name: labels.sendToKitchen, exact: true }).click();
      await retryPage.getByRole('status').filter({ hasText: 'ยังไม่ทราบผลการส่ง' }).waitFor();
      await retryPage.reload();
      await retryPage
        .getByRole('alert')
        .filter({ hasText: labels.tableAwaitingPaymentLocked })
        .waitFor();
      const retryButton = retryPage.getByRole('button', {
        name: 'ตรวจผลโดยส่งรายการเดิมอีกครั้ง',
        exact: true,
      });
      assert(
        await retryButton.isEnabled(),
        'a payment hold still permits checking an uncertain previous attempt',
      );
      await retryButton.click();
      await retryPage.getByRole('status').filter({ hasText: 'ระบบได้รับออเดอร์แล้ว' }).waitFor();
      assert.equal(orderWrites, 2);
      await retryContext.close();
      checks.push('payment hold permits an uncertain accepted-order replay');
    }
    const result = {
      kind: 'controlled browser fixture; not production latency',
      apiDelayMs: delay,
      medianMenuVisibleMs: sorted[Math.floor(sorted.length / 2)],
      samples,
      checks,
    };
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
