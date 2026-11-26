/**
 * QR payment account setting and the dynamic PromptPay QR endpoint.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/payment-qr-code.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payment-qr-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');
const { printerRoutes } = require('../main/routes/printers');
const { insertBillPaymentQr } = require('../main/printers/thermal');
const { crc16Ccitt } = require('../main/lib/promptpay');

async function main() {
  console.log('QR payment account and code');
  console.log('='.repeat(60));
  const db = initTestDb();
  const { authHeader, userId } = seedOwnerUser(db);
  const app = createApp({
    '/api/payment-methods': paymentMethodRoutes,
    '/api/printers': printerRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const qr = (amount: unknown) =>
    api(baseUrl, `/api/payment-methods/qr-code?amount=${amount}`, { headers: authHeader });

  try {
    const missing = await qr(100);
    assertEqualOrThrow(missing.status, 404, 'no QR without an account');
    assertEqualOrThrow(missing.data.code, 'qr_account_missing', 'missing account is reported');

    const bad = await api(baseUrl, '/api/payment-methods/qr-account', {
      method: 'PUT',
      headers: authHeader,
      body: { account: '12345' },
    });
    assertEqualOrThrow(bad.status, 400, 'invalid account is rejected');

    const saved = await api(baseUrl, '/api/payment-methods/qr-account', {
      method: 'PUT',
      headers: authHeader,
      body: { account: '081-234-5678' },
    });
    assertEqualOrThrow(saved.status, 200, 'valid account is saved');
    assertEqualOrThrow(saved.data.account, '0812345678', 'account is stored without separators');
    const read = await api(baseUrl, '/api/payment-methods/qr-account', { headers: authHeader });
    assertEqualOrThrow(read.data.account, '0812345678', 'account is readable by managers');

    const noName = await api(baseUrl, '/api/payment-methods/qr-account-name', {
      headers: authHeader,
    });
    assertEqualOrThrow(noName.data.name, '', 'the account holder name starts empty');
    assertEqualOrThrow((await qr(10)).data.account_name, '', 'the QR has no holder name yet');
    const badName = await api(baseUrl, '/api/payment-methods/qr-account-name', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 42 },
    });
    assertEqualOrThrow(badName.status, 400, 'a non-text holder name is rejected');
    const longName = await api(baseUrl, '/api/payment-methods/qr-account-name', {
      method: 'PUT',
      headers: authHeader,
      body: { name: `  ${'ก'.repeat(70)}  ` },
    });
    assertEqualOrThrow(longName.data.name, 'ก'.repeat(60), 'the holder name is trimmed and capped');

    const ok = await qr(267.5);
    assertEqualOrThrow(ok.status, 200, 'QR is created once an account exists');
    assertOrThrow(
      String(ok.data.data_url).startsWith('data:image/png;base64,'),
      'QR is a PNG data URL',
    );
    assertOrThrow(ok.data.payload.includes('5406267.50'), 'payload carries the bill amount');
    assertEqualOrThrow(
      ok.data.payload.slice(-4),
      crc16Ccitt(ok.data.payload.slice(0, -4)),
      'payload checksum is valid',
    );

    assertEqualOrThrow(ok.data.account_name, 'ก'.repeat(60), 'the QR carries the holder name');

    for (const amount of [0, -5, 'abc']) {
      const response = await qr(amount);
      assertEqualOrThrow(response.status, 400, `amount ${amount} is rejected`);
    }

    // A document printer cannot take the slip, so the POS prints this page instead.
    seedCategory(db, 'drinks', 'Drinks');
    seedProduct(db, 'latte', 'drinks', 'Latte', 250);
    const stamp = new Date().toISOString();
    const orderId = db
      .prepare(`INSERT INTO orders (order_number, user_id, status, subtotal, total, created_at, updated_at)
        VALUES ('ORD-QR-1', ?, 'pending', 250, 250, ?, ?)`)
      .run(userId, stamp, stamp).lastInsertRowid;
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, created_at, updated_at)
      VALUES (?, 'latte', 'Latte <b>', 250, 1, 250, 250, ?, ?)`).run(orderId, stamp, stamp);
    const page = await api(baseUrl, '/api/printers/print-payment-request', {
      method: 'POST',
      headers: authHeader,
      body: { orderId, amount: 250, format: 'html' },
    });
    assertEqualOrThrow(page.status, 200, 'the payment request page is built without a printer');
    const html = String(page.data.html);
    assertOrThrow(html.includes('ORD-QR-1'), 'the page names the order');
    assertOrThrow(html.includes('Latte &#60;b&#62;'), 'item names are escaped');
    assertOrThrow(/<img src="data:image\/png;base64,/.test(html), 'the page carries the QR image');
    assertOrThrow(
      /Scan to pay<\/div><div class="center account-name">ก{60}<\/div><img src="data:image\/png;base64,/.test(
        html,
      ),
      'the page prints the caption, then the holder name, then the QR',
    );

    // Thermal bills carry the PromptPay QR for the total just above the paper cut.
    const receipt = Buffer.from([0x41, 0x0a, 0x1b, 0x64, 0x05, 0x1d, 0x56, 0x00]);
    const printer = { paper_width: '80mm' };
    await api(baseUrl, '/api/payment-methods/qr-account-name', {
      method: 'PUT',
      headers: authHeader,
      body: { name: '' },
    });
    const withQr = await insertBillPaymentQr(receipt, 250, printer);
    const qrAt = withQr.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    assertOrThrow(qrAt > 1, 'the bill carries a QR raster');
    assertOrThrow(
      qrAt < withQr.lastIndexOf(Buffer.from([0x1b, 0x64, 0x05, 0x1d, 0x56, 0x00])),
      'the QR prints before the feed and cut',
    );
    // Without a holder name, a large centred "scan to pay" line sits under the QR, still above the cut.
    const captionAt = withQr.indexOf(Buffer.from('Scan to pay'));
    assertOrThrow(captionAt > qrAt, 'the scan-to-pay line prints under the QR');
    assertOrThrow(
      captionAt < withQr.lastIndexOf(Buffer.from([0x1b, 0x64, 0x05, 0x1d, 0x56, 0x00])),
      'the scan-to-pay line prints before the feed and cut',
    );
    assertOrThrow(
      withQr.subarray(qrAt, captionAt).includes(Buffer.from([0x1b, 0x61, 0x01])),
      'the scan-to-pay line is centred',
    );

    // With a holder name the bill reads caption, then the name in large bold, then the QR.
    const savedName = await api(baseUrl, '/api/payment-methods/qr-account-name', {
      method: 'PUT',
      headers: authHeader,
      body: { name: '  Flo   Cafe  Co. ' },
    });
    assertEqualOrThrow(savedName.data.name, 'Flo Cafe Co.', 'the holder name collapses spaces');
    const named = await insertBillPaymentQr(receipt, 250, printer);
    const namedCaptionAt = named.indexOf(Buffer.from('Scan to pay'));
    const nameAt = named.indexOf(Buffer.from('Flo Cafe Co.'));
    const namedQrAt = named.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    assertOrThrow(
      namedCaptionAt > 0 && nameAt > namedCaptionAt && namedQrAt > nameAt,
      'a named bill prints the caption, then the holder name, then the QR',
    );
    assertOrThrow(
      named.lastIndexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) <
        named.lastIndexOf(Buffer.from([0x1b, 0x64, 0x05, 0x1d, 0x56, 0x00])),
      'the QR still prints before the feed and cut',
    );
    const nameStyle = named.subarray(namedCaptionAt + 'Scan to pay'.length, nameAt);
    assertOrThrow(
      nameStyle.includes(Buffer.from([0x1b, 0x61, 0x01])),
      'the holder name is centred',
    );
    const modeAt = nameStyle.lastIndexOf(Buffer.from([0x1b, 0x21]));
    assertOrThrow(
      modeAt >= 0 && (nameStyle[modeAt + 2] & 0x18) === 0x18,
      'the holder name prints bold and double height',
    );
    assertOrThrow(!withQr.includes(Buffer.from('Flo Cafe')), 'no name line without a name');
    // A printer that cannot draw Thai as text still prints the QR; the line follows the bill's raster path.
    const thai = await insertBillPaymentQr(receipt, 250, printer, 'th');
    assertOrThrow(thai.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])), 'a Thai bill keeps its QR');
    assertOrThrow(
      !thai.includes(Buffer.from('Scan to pay')),
      'a Thai bill does not fall back to English',
    );
    assertEqualOrThrow(
      await insertBillPaymentQr(receipt, 0, printer),
      receipt,
      'a zero bill prints no QR',
    );

    const cleared = await api(baseUrl, '/api/payment-methods/qr-account', {
      method: 'PUT',
      headers: authHeader,
      body: { account: '' },
    });
    assertEqualOrThrow(cleared.status, 200, 'account can be cleared');
    assertEqualOrThrow((await qr(100)).status, 404, 'cleared account stops QR creation');
    assertEqualOrThrow(
      await insertBillPaymentQr(receipt, 250, printer),
      receipt,
      'a shop without PromptPay prints bills without a QR',
    );

    // A second PromptPay method keeps its own account, such as a phone number beside a national ID.
    const createMethod = async (name: string) =>
      (
        await api(baseUrl, '/api/payment-methods', {
          method: 'POST',
          headers: authHeader,
          body: { name },
        })
      ).data.payment_method.id as number;
    const idMethod = await createMethod('พร้อมเพย์');
    const phoneMethod = await createMethod('พร้อมเพย์ เบอร์โทร');
    const otherMethod = await createMethod('Voucher');
    const putAccount = (id: number, body: Record<string, unknown>) =>
      api(baseUrl, `/api/payment-methods/promptpay-accounts/${id}`, {
        method: 'PUT',
        headers: authHeader,
        body,
      });
    const mainAccount = async () =>
      (await api(baseUrl, '/api/payment-methods/qr-account', { headers: authHeader })).data.account;
    const listed = await api(baseUrl, '/api/payment-methods/promptpay-accounts', {
      headers: authHeader,
    });
    assertEqualOrThrow(
      listed.data.accounts.map((row: any) => row.method_id).join(','),
      `${idMethod},${phoneMethod}`,
      'only PromptPay-named methods get an account',
    );
    assertEqualOrThrow(listed.data.bill_method_id, null, 'bills start on the main account');
    assertEqualOrThrow(
      (await putAccount(otherMethod, { account: '0812345678' })).status,
      404,
      'a non-PromptPay method has no account',
    );
    assertEqualOrThrow(
      (await putAccount(phoneMethod, { account: '+1 202 555 0100' })).status,
      400,
      'an invalid phone is rejected',
    );
    assertEqualOrThrow(
      (await putAccount(phoneMethod, { name: 7 })).status,
      400,
      'a non-text name is rejected',
    );

    const idSaved = await putAccount(idMethod, { account: '1-2345-67890-12-3', name: 'ID holder' });
    assertEqualOrThrow(idSaved.data.account.account, '1234567890123', 'the ID account is saved');
    assertEqualOrThrow(
      await mainAccount(),
      '1234567890123',
      'the oldest PromptPay method holds the main account',
    );
    const phoneSaved = await putAccount(phoneMethod, {
      account: '+66 81 234 5678',
      name: 'Phone holder',
    });
    assertEqualOrThrow(
      phoneSaved.data.account.account,
      '0812345678',
      'the phone is stored as 0XXXXXXXXX',
    );
    assertEqualOrThrow(phoneSaved.data.account.name, 'Phone holder', 'the phone has its own name');
    assertEqualOrThrow(
      await mainAccount(),
      '1234567890123',
      'saving the phone account leaves the main account alone',
    );

    const byId = await qr(100);
    assertOrThrow(
      byId.data.payload.includes('02131234567890123'),
      'bills default to the main ID account',
    );
    assertEqualOrThrow(byId.data.account_name, 'ID holder', 'the main account name prints');

    const choose = (method_id: unknown) =>
      api(baseUrl, '/api/payment-methods/promptpay-bill-method', {
        method: 'PUT',
        headers: authHeader,
        body: { method_id },
      });
    assertEqualOrThrow(
      (await choose(otherMethod)).status,
      404,
      'only a PromptPay method can print on bills',
    );
    assertEqualOrThrow(
      (await choose(phoneMethod)).data.bill_method_id,
      phoneMethod,
      'the phone account is chosen for bills',
    );
    const byPhone = await qr(100);
    assertOrThrow(
      byPhone.data.payload.includes('01130066812345678'),
      'the bill QR pays the phone number',
    );
    assertOrThrow(
      !byPhone.data.payload.includes('1234567890123'),
      'the bill QR no longer pays the ID',
    );
    assertEqualOrThrow(
      byPhone.data.payload.slice(-4),
      crc16Ccitt(byPhone.data.payload.slice(0, -4)),
      'the phone payload checksum is valid',
    );
    assertEqualOrThrow(byPhone.data.account_name, 'Phone holder', 'the phone account name prints');
    const phoneBill = await insertBillPaymentQr(receipt, 250, printer);
    assertOrThrow(
      phoneBill.includes(Buffer.from('Phone holder')),
      'the thermal bill names the phone account',
    );
    const phoneSlip = await api(baseUrl, '/api/printers/print-payment-request', {
      method: 'POST',
      headers: authHeader,
      body: { orderId, amount: 250, format: 'html' },
    });
    assertOrThrow(
      String(phoneSlip.data.html).includes('Phone holder'),
      'the payment request names the phone account',
    );

    await api(baseUrl, `/api/payment-methods/${phoneMethod}`, {
      method: 'PUT',
      headers: authHeader,
      body: { is_active: false },
    });
    assertOrThrow(
      (await qr(100)).data.payload.includes('02131234567890123'),
      'a disabled phone method falls back to the main account',
    );
    assertEqualOrThrow((await choose(null)).data.bill_method_id, null, 'the bill choice resets');
    console.log('\nAll QR payment checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
