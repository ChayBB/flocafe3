const fs = require('node:fs');
const { chromium } = require('../frontend/node_modules/playwright');

async function main() {
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'https:') throw new Error('An HTTPS ordering URL is required');
  const browser = await chromium.launch({
    chromiumSandbox: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const samples = [];
  try {
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = (input, options) => {
          const address =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(address, location.href).pathname === '/api/v1/table-qr/session') {
            return Promise.resolve(new Response('{}', { status: 409 }));
          }
          if (
            (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() !==
            'GET'
          ) {
            throw new Error('Live benchmark permits only read requests');
          }
          return fetch(input, options);
        };
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-testid="pos-product-grid"]')?.textContent.trim())
            return;
          window.__orderingMenuVisibleMs = performance.now();
          observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      const page = await context.newPage();
      for (const cache of ['cold', 'warm']) {
        if (cache === 'cold')
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        else await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForFunction(() => typeof window.__orderingMenuVisibleMs === 'number', null, {
          timeout: 90_000,
        });
        await page.waitForFunction(
          () =>
            performance
              .getEntriesByType('resource')
              .some((entry) => entry.name.endsWith('/menu-presentation.json')),
          null,
          { timeout: 20_000 },
        );
        const sample = await page.evaluate(() => ({
          menuVisibleMs: Math.round(window.__orderingMenuVisibleMs),
          resources: performance.getEntriesByType('resource').map((resource) => ({
            path: new URL(resource.name).pathname,
            transferBytes: resource.transferSize,
            durationMs: Math.round(resource.duration),
          })),
        }));
        samples.push({ run, cache, ...sample });
      }
      await context.close();
    }
    const medians = Object.fromEntries(
      ['cold', 'warm'].map((cache) => {
        const values = samples
          .filter((sample) => sample.cache === cache)
          .map((sample) => sample.menuVisibleMs)
          .sort((a, b) => a - b);
        return [cache, values[Math.floor(values.length / 2)]];
      }),
    );
    const result = {
      kind: 'live read-only browse mode; session creation intercepted in browser',
      origin: url.origin,
      medians,
      samples,
    };
    fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ medians, samples: samples.length }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
