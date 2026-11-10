const { readFileSync, writeFileSync } = require('node:fs');
const QRCode = require('qrcode');

async function main() {
  let url;
  try {
    url = new URL(readFileSync(0, 'utf8').trim());
  } catch {
    throw new Error('Provide a complete HTTPS menu-preview URL on standard input.');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search ||
    url.pathname !== '/menu-preview' ||
    !/^#[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i.test(url.hash)
  ) throw new Error('Use the HTTPS origin and preview_path returned by the menu preview API.');
  const image = await QRCode.toBuffer(url.href, { width: 440, margin: 4 });
  writeFileSync('menu-preview-qr.png', image, { flag: 'wx' });
  console.log('Created menu-preview-qr.png');
}

main().catch(() => {
  console.error('Could not generate a QR. Check the HTTPS preview URL and output directory.');
  process.exitCode = 1;
});
