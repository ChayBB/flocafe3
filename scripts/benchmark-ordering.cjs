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
const samples = [];
let requests = [];
let scenario = 'ok';
let presentationReads = 0;
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
    if (url.pathname.endsWith('/session') && scenario === 'closed') {
      res.writeHead(409).end('{}');
      return;
    }
    if (url.pathname.endsWith('/session') && scenario === 'limited') {
      res.writeHead(429).end('{}');
      return;
    }
    if (url.pathname.endsWith('/menu') && req.headers.authorization && scenario === 'expired') {
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
      ? { table_token: token }
      : url.pathname.endsWith('/menu')
        ? {
            items: [{ id: item, name: 'Benchmark Coffee', price_satang: 5000, category: 'Drinks' }],
          }
        : { orders: [] };
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
        'preview-failed',
        'token-only',
      ]) {
        scenario = current;
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        if (current === 'expired') {
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
            await page.getByRole('status').filter({ hasText: 'โต๊ะนี้ยังไม่เปิดรับออเดอร์' }).waitFor();
            assert.equal(
              await page.getByRole('button', { name: labels.currentTicket, exact: true }).count(),
              0,
            );
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
