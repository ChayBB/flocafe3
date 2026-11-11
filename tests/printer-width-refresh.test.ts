const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-width-refresh-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const {
  initPrinter,
  prepareReceipt,
  escPosToText,
  resolveBillPrinterContext,
} = require('../main/printers/thermal');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function main() {
  initDatabase();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO printers (id, name, connection_type, paper_width, is_default, created_at, updated_at)
    VALUES ('receipt-printer', 'Receipt Printer', 'usb', 'cols-32', 1, ?, ?)
  `).run(now(), now());

  await initPrinter();
  db.prepare(
    "UPDATE printers SET paper_width = 'cols-48', updated_at = ? WHERE id = 'receipt-printer'",
  ).run(now());

  const prepared = prepareReceipt(
    {
      order_number: 'ORD-WIDTH-1',
      created_at: '2026-08-11 12:00:00',
      items: [{ product_name: 'Cheese Burger', quantity: 1, total: 63, addons: [] }],
    },
    { bill_number: 'INV-WIDTH-1', subtotal: 60, tax_amount: 3, discount_amount: 0, total: 63 },
    { name: 'Width Test', currency_symbol: 'Rs', country: 'IN' },
    'classic',
  );

  // Bills sit inside side margins, so a 48-column printer prints fewer bill columns.
  const expectedColumns = resolveBillPrinterContext({
    id: 'receipt-printer',
    connection_type: 'usb',
    paper_width: 'cols-48',
  }).columns;
  assert(
    expectedColumns > 32,
    `a 48-column printer still gives a wider bill than 32 (${expectedColumns})`,
  );
  assert(
    prepared.columns === expectedColumns,
    `invoice preparation reads the updated printer width after startup (got ${prepared.columns}, expected ${expectedColumns})`,
  );
  const preview = escPosToText(prepared.data);
  assert(
    preview.split('\n').some((line: string) => line.trim() === '-'.repeat(expectedColumns)),
    `invoice separators use the updated ${expectedColumns}-column width`,
  );
  assert(
    !preview.split('\n').some((line: string) => line === '-'.repeat(32)),
    'invoice does not retain the stale 32-column width',
  );

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: Error) => {
  console.error(error);
  try {
    closeDatabase();
  } catch {}
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
