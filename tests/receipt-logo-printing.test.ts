/**
 * Receipt Logo Printing Tests
 *
 * Verifies:
 * 1. 1-bit raster packing, unpacking, dithering, centering, and band extraction.
 * 2. Document model populating logo fields based on showLogo toggle.
 * 3. ESC/POS raster band generation and GS v 0 byte emission.
 * 4. KOT tickets never printing business logo.
 * 5. Multi-width raster variant selection (384 dots for 58mm, 576 dots for 80mm).
 * 6. Settings API logo validation (payload size limits, data URL validation).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pack1BitPixels,
  unpack1BitPixels,
  ditherGrayscalePixels,
  centerPixels,
  getLogoRasterBands,
  RECEIPT_LOGO_PRINT_SCALE,
  receiptLogoPrintScale,
  receiptLogoOffsetDots,
  normalizeReceiptLogoSize,
  parseReceiptLogoData,
  findLogoContentBounds,
  normalizeGrayscaleContrast,
  shouldAutoEnableBillShowLogo,
  type ReceiptLogoData,
} from '../shared/print/image-raster';
import { encodeGsV0Band, concatBytes, type RasterRenderRequest } from '../shared/print/raster';
import { GENERIC_THERMAL_CAPABILITIES } from '../shared/print/thermal-capabilities';
import { buildBillDocument, getBlock, type BusinessHeaderBlock } from '../shared/print/document';

// Mock electron before importing db / app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receipt-logo-test-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const { buildBillPrintData } = require('../main/printers/document-classic');
const {
  formatReceipt,
  formatKOT,
  receiptDocumentLines,
  buildEscPos,
} = require('../main/printers/thermal');
const { renderUnsupportedRasterLines } = require('../main/printers/raster-renderer');
const { settingsRoutes } = require('../main/routes/settings');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  seedOwnerUser,
  closeDatabase,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
} = require('./helpers/test-setup');

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

function createSampleLogoData(): { logoUrl: string; rasterJson: string } {
  const logoUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // 16x16 dummy bitmap with alternating black/white pixels
  const w = 16;
  const h = 16;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      pixels[y * w + x] = (x + y) % 2 === 0 ? 1 : 0;
    }
  }
  const packed = pack1BitPixels(pixels, w, h);
  const dataBase64 = uint8ToBase64(packed);

  const rasterObj: ReceiptLogoData = {
    version: 1,
    originalDataUrl: logoUrl,
    variants: {
      '384': { width: w, height: h, dataBase64 },
      '576': { width: w, height: h, dataBase64 },
    },
  };

  return {
    logoUrl,
    rasterJson: JSON.stringify(rasterObj),
  };
}

function gsV0Heights(bytes: Uint8Array): { widths: number[]; totalHeight: number } {
  const widths: number[] = [];
  let totalHeight = 0;
  for (let i = 0; i + 7 < bytes.length; i += 1) {
    if (bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const widthBytes = bytes[i + 4] | (bytes[i + 5] << 8);
      const height = bytes[i + 6] | (bytes[i + 7] << 8);
      widths.push(widthBytes * 8);
      totalHeight += height;
      i += 7 + widthBytes * height;
    }
  }
  return { widths, totalHeight };
}

function bandInkColumns(bands: { widthDots: number; pixels: Uint8Array }[]): number {
  let min = Infinity;
  let max = -1;
  for (const band of bands) {
    for (let i = 0; i < band.pixels.length; i += 1) {
      if (band.pixels[i] === 0) continue;
      const x = i % band.widthDots;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return max < 0 ? 0 : max - min + 1;
}

function bandInkLeft(bands: { widthDots: number; pixels: Uint8Array }[]): number {
  let min = Infinity;
  for (const band of bands) {
    for (let i = 0; i < band.pixels.length; i += 1) {
      if (band.pixels[i] !== 0) min = Math.min(min, i % band.widthDots);
    }
  }
  return min;
}

function solidLogoJson(width: number, height: number): string {
  const pixels = new Uint8Array(width * height).fill(1);
  const dataBase64 = uint8ToBase64(pack1BitPixels(pixels, width, height));
  const variant = { width, height, dataBase64 };
  const logo: ReceiptLogoData = {
    version: 1,
    originalDataUrl: 'data:image/png;base64,AA==',
    variants: { '384': variant, '576': variant },
  };
  return JSON.stringify(logo);
}

async function run() {
  console.log('--- 1. Image Raster pure functions ---');

  // pack1BitPixels and unpack1BitPixels
  const w = 8;
  const h = 2;
  const original = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1]);
  const packed = pack1BitPixels(original, w, h);
  assertEqualOrThrow(packed.length, 2, 'Packed bytes length should be 2 for 8x2 1-bit pixels');
  assertEqualOrThrow(packed[0], 0xaa, 'Row 0 packed MSB-first should be 0xAA (10101010)');
  assertEqualOrThrow(packed[1], 0x55, 'Row 1 packed MSB-first should be 0x55 (01010101)');

  const unpacked = unpack1BitPixels(packed, w, h);
  for (let i = 0; i < original.length; i += 1) {
    assertEqualOrThrow(unpacked[i], original[i], `Unpacked pixel ${i} should match original`);
  }

  // ditherGrayscalePixels (Floyd-Steinberg error diffusion)
  const grayscale = new Float32Array([
    255,
    255, // Pure white
    0,
    0, // Pure black
  ]);
  const dithered = ditherGrayscalePixels(grayscale, 2, 2);
  assertEqualOrThrow(dithered[0], 0, 'White grayscale pixel should dither to 0 (no ink)');
  assertEqualOrThrow(dithered[1], 0, 'White grayscale pixel should dither to 0 (no ink)');
  assertEqualOrThrow(dithered[2], 1, 'Black grayscale pixel should dither to 1 (ink)');
  assertEqualOrThrow(dithered[3], 1, 'Black grayscale pixel should dither to 1 (ink)');

  // centerPixels
  const uncentered = new Uint8Array([1, 1]); // 2x1
  const centered = centerPixels(uncentered, 2, 1, 6); // pad to 6
  assertEqualOrThrow(centered.length, 6, 'Centered row length should equal target width');
  // Left pad should be (6 - 2) / 2 = 2
  assertEqualOrThrow(centered[0], 0, 'Left padding pixel 0 should be 0');
  assertEqualOrThrow(centered[1], 0, 'Left padding pixel 1 should be 0');
  assertEqualOrThrow(centered[2], 1, 'Centered pixel 2 should be 1');
  assertEqualOrThrow(centered[3], 1, 'Centered pixel 3 should be 1');
  assertEqualOrThrow(centered[4], 0, 'Right padding pixel 4 should be 0');
  assertEqualOrThrow(centered[5], 0, 'Right padding pixel 5 should be 0');

  // getLogoRasterBands variant resolution
  const { logoUrl, rasterJson } = createSampleLogoData();
  const bands58 = getLogoRasterBands(rasterJson, 384);
  assertOrThrow(bands58.length > 0, 'Should resolve bands for 384 dots');
  assertEqualOrThrow(bands58[0].widthDots, 384, 'Resolved band width should be 384 dots');

  const bands80 = getLogoRasterBands(rasterJson, 576);
  assertOrThrow(bands80.length > 0, 'Should resolve bands for 576 dots');
  assertEqualOrThrow(bands80[0].widthDots, 576, 'Resolved band width should be 576 dots');

  const tallPixels = new Uint8Array(576 * 288);
  tallPixels[tallPixels.length - 1] = 1;
  const tallPacked = pack1BitPixels(tallPixels, 576, 288);
  const tallLogo = JSON.stringify({
    version: 1,
    originalDataUrl: logoUrl,
    variants: { '576': { width: 576, height: 288, dataBase64: uint8ToBase64(tallPacked) } },
  });
  const tallBands = getLogoRasterBands(tallLogo, 576);
  assertEqualOrThrow(tallBands.length, 2, 'Tall logos should be split into bounded bands');

  const smallPixels = new Uint8Array(100 * 50);
  smallPixels[0] = 1;
  const smallLogo = JSON.stringify({
    version: 1,
    originalDataUrl: logoUrl,
    variants: {
      '384': {
        width: 100,
        height: 50,
        dataBase64: uint8ToBase64(pack1BitPixels(smallPixels, 100, 50)),
      },
    },
  });
  const doubled = getLogoRasterBands(smallLogo, 384, 200, 2);
  assertEqualOrThrow(doubled[0].heightDots, 100, 'A 2x print scale doubles the logo height');
  const left = (384 - 200) / 2;
  assertEqualOrThrow(doubled[0].pixels[left + 1], 1, 'A 2x print scale doubles each pixel across');
  assertEqualOrThrow(doubled[0].pixels[384 + left], 1, 'A 2x print scale doubles each pixel down');
  assertEqualOrThrow(
    getLogoRasterBands(smallLogo, 384, 200, 4)[0].heightDots,
    150,
    'The print scale stops at the paper width',
  );
  assertEqualOrThrow(
    tallBands[0].heightDots,
    200,
    'First tall logo band should use the height limit',
  );
  assertEqualOrThrow(
    tallBands[1].heightDots,
    88,
    'Second tall logo band should retain remaining rows',
  );
  assertEqualOrThrow(
    tallBands[1].pixels.at(-1),
    1,
    'Last row should be preserved in the final band',
  );

  const malformedLogo = JSON.stringify({
    version: 1,
    originalDataUrl: logoUrl,
    variants: { '576': { width: Number.MAX_SAFE_INTEGER, height: 2, dataBase64: 'AAAA' } },
  });
  assertEqualOrThrow(
    getLogoRasterBands(malformedLogo, 576).length,
    0,
    'Invalid dimensions should be rejected',
  );

  // Decoupled ReceiptLogoData (originalDataUrl: "")
  const decoupledLogoJson = JSON.stringify({
    version: 1,
    originalDataUrl: '',
    variants: JSON.parse(rasterJson).variants,
  });
  const parsedDecoupled = parseReceiptLogoData(decoupledLogoJson);
  assertOrThrow(
    parsedDecoupled !== null,
    'parseReceiptLogoData should accept empty originalDataUrl',
  );
  assertEqualOrThrow(
    parsedDecoupled?.originalDataUrl,
    '',
    'Decoupled originalDataUrl should remain empty',
  );
  const decoupledBands = getLogoRasterBands(decoupledLogoJson, 384);
  assertOrThrow(
    decoupledBands.length > 0,
    'getLogoRasterBands should resolve bands from decoupled ReceiptLogoData',
  );

  // findLogoContentBounds: trim surrounding white/transparent borders with 4px margin
  const boundsW = 20;
  const boundsH = 20;
  const rgba = new Uint8Array(boundsW * boundsH * 4);
  // Fill with white (255, 255, 255, 255)
  rgba.fill(255);
  // Draw a 4x4 dark square at (8..11, 8..11)
  for (let y = 8; y <= 11; y += 1) {
    for (let x = 8; x <= 11; x += 1) {
      const idx = (y * boundsW + x) * 4;
      rgba[idx] = 20;
      rgba[idx + 1] = 20;
      rgba[idx + 2] = 20;
      rgba[idx + 3] = 255;
    }
  }
  const trimmedBounds = findLogoContentBounds(rgba, boundsW, boundsH, 4);
  assertEqualOrThrow(trimmedBounds.x, 4, 'Trimmed x should include 4px margin (8 - 4)');
  assertEqualOrThrow(trimmedBounds.y, 4, 'Trimmed y should include 4px margin (8 - 4)');
  assertEqualOrThrow(trimmedBounds.width, 12, 'Trimmed width should be 12 (4..15)');
  assertEqualOrThrow(trimmedBounds.height, 12, 'Trimmed height should be 12 (4..15)');

  // Blank image fallback in findLogoContentBounds
  const blankRgba = new Uint8Array(10 * 10 * 4).fill(255);
  const blankBounds = findLogoContentBounds(blankRgba, 10, 10, 4);
  assertEqualOrThrow(blankBounds.x, 0, 'Blank image x should fallback to 0');
  assertEqualOrThrow(blankBounds.y, 0, 'Blank image y should fallback to 0');
  assertEqualOrThrow(blankBounds.width, 10, 'Blank image width should fallback to full width');
  assertEqualOrThrow(blankBounds.height, 10, 'Blank image height should fallback to full height');

  // normalizeGrayscaleContrast: stretches low-contrast [150, 255] to [0, 255]
  const lowContrast = new Float32Array([150, 202.5, 255]);
  const stretched = normalizeGrayscaleContrast(lowContrast);
  assertEqualOrThrow(Math.round(stretched[0]), 0, 'Minimum luminance should stretch to 0 (black)');
  assertEqualOrThrow(Math.round(stretched[1]), 128, 'Midpoint luminance should stretch to ~128');
  assertEqualOrThrow(
    Math.round(stretched[2]),
    255,
    'Maximum luminance should stretch to 255 (white)',
  );

  // Verify shouldAutoEnableBillShowLogo guards auto-enabling bill_show_logo on save
  assertEqualOrThrow(
    shouldAutoEnableBillShowLogo({
      logoChanged: true,
      receiptLogo: logoUrl,
      pendingAutoEnable: true,
      visibilityOverriddenAfterUpload: false,
    }),
    true,
    'shouldAutoEnableBillShowLogo should return true when a logo is uploaded and visibility was not overridden',
  );
  assertEqualOrThrow(
    shouldAutoEnableBillShowLogo({
      logoChanged: true,
      receiptLogo: logoUrl,
      pendingAutoEnable: true,
      visibilityOverriddenAfterUpload: true,
    }),
    false,
    'shouldAutoEnableBillShowLogo should return false when merchant explicitly toggled Store Logo after upload',
  );
  assertEqualOrThrow(
    shouldAutoEnableBillShowLogo({
      logoChanged: true,
      receiptLogo: logoUrl,
      pendingAutoEnable: false,
      visibilityOverriddenAfterUpload: false,
    }),
    false,
    'shouldAutoEnableBillShowLogo should return false when no upload is pending (e.g. after reset)',
  );
  assertEqualOrThrow(
    shouldAutoEnableBillShowLogo({
      logoChanged: true,
      receiptLogo: '',
      pendingAutoEnable: true,
      visibilityOverriddenAfterUpload: false,
    }),
    false,
    'shouldAutoEnableBillShowLogo should return false when logo was removed before saving',
  );
  assertEqualOrThrow(
    shouldAutoEnableBillShowLogo({
      logoChanged: false,
      receiptLogo: logoUrl,
      pendingAutoEnable: true,
      visibilityOverriddenAfterUpload: false,
    }),
    false,
    'shouldAutoEnableBillShowLogo should return false when logo did not change from saved state',
  );

  console.log('--- 2. Document model logo integration ---');
  const dummyBill = {
    bill_number: 'INV-100',
    subtotal: 10,
    tax_amount: 0,
    total: 10,
  };
  const dummyOrder = {
    order_number: 'ORD-100',
    created_at: new Date().toISOString(),
    items: [{ product_name: 'Espresso', quantity: 1, unit_price: 10, total: 10 }],
  };

  const printContext = {
    columns: 32,
    languages: ['en'] as readonly string[],
    baseDirection: 'ltr' as const,
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    resolveLabel: (_concept: string, _lang: string) => 'Text',
  };

  const printDataWithLogo = buildBillPrintData(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      show_logo: true,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    false,
  );

  const docWithLogo = buildBillDocument(printDataWithLogo, printContext);

  const headerBlockWithLogo = getBlock(docWithLogo, 'business-header') as BusinessHeaderBlock;
  assertOrThrow(headerBlockWithLogo !== undefined, 'Business header block should exist');
  assertEqualOrThrow(headerBlockWithLogo.logo, logoUrl, 'Header block should contain logo URL');
  assertEqualOrThrow(
    headerBlockWithLogo.logoRaster,
    rasterJson,
    'Header block should contain logo raster JSON',
  );

  const printDataWithoutLogo = buildBillPrintData(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      show_logo: false,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    false,
  );

  const docWithoutLogo = buildBillDocument(printDataWithoutLogo, printContext);

  const headerBlockWithoutLogo = getBlock(docWithoutLogo, 'business-header') as BusinessHeaderBlock;
  assertEqualOrThrow(
    headerBlockWithoutLogo.logo,
    null,
    'Header block logo should be null when showLogo is false',
  );
  assertEqualOrThrow(
    headerBlockWithoutLogo.logoRaster,
    null,
    'Header block logoRaster should be null when showLogo is false',
  );

  console.log('--- 3. ESC/POS byte generation ---');

  const receiptBytesWithLogo = formatReceipt(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      country: 'US',
      currency: 'USD',
      show_logo: true,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    'classic',
    32,
  );

  // GS v 0 signature: 0x1D 0x76 0x30 0x00
  let foundGsV0 = false;
  for (let i = 0; i < receiptBytesWithLogo.length - 4; i += 1) {
    if (
      receiptBytesWithLogo[i] === 0x1d &&
      receiptBytesWithLogo[i + 1] === 0x76 &&
      receiptBytesWithLogo[i + 2] === 0x30 &&
      receiptBytesWithLogo[i + 3] === 0x00
    ) {
      foundGsV0 = true;
      break;
    }
  }
  assertOrThrow(
    foundGsV0,
    'Receipt ESC/POS bytes should contain GS v 0 raster command when show_logo is true',
  );

  const receiptBytesWithoutLogo = formatReceipt(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      country: 'US',
      currency: 'USD',
      show_logo: false,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    'classic',
    32,
  );

  let foundGsV0WithoutLogo = false;
  for (let i = 0; i < receiptBytesWithoutLogo.length - 4; i += 1) {
    if (
      receiptBytesWithoutLogo[i] === 0x1d &&
      receiptBytesWithoutLogo[i + 1] === 0x76 &&
      receiptBytesWithoutLogo[i + 2] === 0x30 &&
      receiptBytesWithoutLogo[i + 3] === 0x00
    ) {
      foundGsV0WithoutLogo = true;
      break;
    }
  }
  assertOrThrow(
    !foundGsV0WithoutLogo,
    'Receipt ESC/POS bytes should not contain GS v 0 command when show_logo is false',
  );

  // Compact template logo emission
  const compactBytesWithLogo = formatReceipt(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      country: 'US',
      currency: 'USD',
      show_logo: true,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    'compact',
    32,
  );
  let foundGsV0Compact = false;
  for (let i = 0; i < compactBytesWithLogo.length - 4; i += 1) {
    if (
      compactBytesWithLogo[i] === 0x1d &&
      compactBytesWithLogo[i + 1] === 0x76 &&
      compactBytesWithLogo[i + 2] === 0x30 &&
      compactBytesWithLogo[i + 3] === 0x00
    ) {
      foundGsV0Compact = true;
      break;
    }
  }
  assertOrThrow(
    foundGsV0Compact,
    'Compact receipt ESC/POS bytes should contain GS v 0 raster command when show_logo is true',
  );

  const compactBytesWithoutLogo = formatReceipt(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      country: 'US',
      currency: 'USD',
      show_logo: false,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    'compact',
    32,
  );
  let foundGsV0CompactWithoutLogo = false;
  for (let i = 0; i < compactBytesWithoutLogo.length - 4; i += 1) {
    if (
      compactBytesWithoutLogo[i] === 0x1d &&
      compactBytesWithoutLogo[i + 1] === 0x76 &&
      compactBytesWithoutLogo[i + 2] === 0x30 &&
      compactBytesWithoutLogo[i + 3] === 0x00
    ) {
      foundGsV0CompactWithoutLogo = true;
      break;
    }
  }
  assertOrThrow(
    !foundGsV0CompactWithoutLogo,
    'Compact receipt ESC/POS bytes should not contain GS v 0 command when show_logo is false',
  );

  console.log('--- 3c. Logo size setting ---');
  assertEqualOrThrow(receiptLogoPrintScale(undefined), RECEIPT_LOGO_PRINT_SCALE, 'unset is 2x');
  assertEqualOrThrow(receiptLogoPrintScale('medium'), RECEIPT_LOGO_PRINT_SCALE, 'medium is 2x');
  assertEqualOrThrow(receiptLogoPrintScale('small'), 1, 'small is 1x');
  assertEqualOrThrow(receiptLogoPrintScale('large'), 3, 'large is 3x');
  assertEqualOrThrow(normalizeReceiptLogoSize('huge'), 'medium', 'unknown size falls back');

  const sizeLogoJson = solidLogoJson(64, 40);
  for (const [size, expectedWidth, expectedHeight] of [
    ['small', 64, 40],
    ['medium', 128, 80],
    ['large', 192, 120],
  ] as const) {
    const bands = getLogoRasterBands(sizeLogoJson, 384, 200, receiptLogoPrintScale(size));
    assertEqualOrThrow(
      bands.reduce((sum, band) => sum + band.heightDots, 0),
      expectedHeight,
      `${size} logo height on 58mm`,
    );
    assertEqualOrThrow(bandInkColumns(bands), expectedWidth, `${size} logo width on 58mm`);
    assertOrThrow(
      bands.every((band) => band.widthDots === 384 && band.widthDots % 8 === 0),
      `${size} logo bands span the printable width in whole bytes`,
    );
  }

  const wideLogoJson = solidLogoJson(200, 40);
  const wideLarge58 = getLogoRasterBands(wideLogoJson, 384, 200, receiptLogoPrintScale('large'));
  assertEqualOrThrow(bandInkColumns(wideLarge58), 200, 'large wide logo clamps to 1x on 58mm');
  assertOrThrow(
    wideLarge58.every((band) => band.widthDots === 384),
    'clamped logo never exceeds 384 dots',
  );
  const wideLarge80 = getLogoRasterBands(wideLogoJson, 576, 200, receiptLogoPrintScale('large'));
  assertEqualOrThrow(bandInkColumns(wideLarge80), 400, 'large wide logo clamps to 2x on 80mm');
  assertEqualOrThrow(
    wideLarge80.reduce((sum, band) => sum + band.heightDots, 0),
    80,
    'clamped logo keeps its aspect ratio',
  );

  const sizedReceipt = (template: 'classic' | 'compact', size?: string): Uint8Array =>
    formatReceipt(
      dummyOrder,
      dummyBill,
      {
        name: 'Flo Cafe',
        country: 'US',
        currency: 'USD',
        show_logo: true,
        receipt_logo: logoUrl,
        receipt_logo_raster: sizeLogoJson,
        show_name: true,
        ...(size === undefined ? {} : { receipt_logo_size: size }),
      },
      template,
      32,
    );
  for (const template of ['classic', 'compact'] as const) {
    const unset = sizedReceipt(template);
    assertEqualOrThrow(
      Buffer.from(sizedReceipt(template, 'medium')).toString('hex'),
      Buffer.from(unset).toString('hex'),
      `${template}: medium bytes match a shop with no saved size`,
    );
    assertEqualOrThrow(
      Buffer.from(sizedReceipt(template, '')).toString('hex'),
      Buffer.from(unset).toString('hex'),
      `${template}: empty stored size prints like medium`,
    );
    assertEqualOrThrow(gsV0Heights(unset).totalHeight, 80, `${template}: default logo height`);
    assertEqualOrThrow(
      gsV0Heights(sizedReceipt(template, 'small')).totalHeight,
      40,
      `${template}: small logo height`,
    );
    const large = gsV0Heights(sizedReceipt(template, 'large'));
    assertEqualOrThrow(large.totalHeight, 120, `${template}: large logo height`);
    assertOrThrow(
      large.widths.length > 0 && large.widths.every((width) => width === 384),
      `${template}: large logo bands stay within 384 dots`,
    );
  }

  console.log('--- 3c2. Logo size slider scale ---');
  assertEqualOrThrow(normalizeReceiptLogoSize('1.5'), 1.5, 'stored slider scale parses');
  assertEqualOrThrow(normalizeReceiptLogoSize(9), 3, 'slider scale clamps to the maximum');
  assertEqualOrThrow(normalizeReceiptLogoSize(0.1), 0.5, 'slider scale clamps to the minimum');
  const sliderBands = getLogoRasterBands(sizeLogoJson, 384, 200, 1.5, 0, true);
  assertEqualOrThrow(bandInkColumns(sliderBands), 96, 'x1.5 logo width');
  assertEqualOrThrow(
    sliderBands.reduce((sum, band) => sum + band.heightDots, 0),
    60,
    'x1.5 logo height',
  );
  assertOrThrow(
    sliderBands.every((band) => band.widthDots === 384),
    'slider logo bands span the printable width',
  );
  const sliderFit = getLogoRasterBands(wideLogoJson, 384, 200, 3, 0, true);
  assertEqualOrThrow(bandInkColumns(sliderFit), 384, 'large slider scale fits the paper width');
  assertEqualOrThrow(
    sliderFit.reduce((sum, band) => sum + band.heightDots, 0),
    77,
    'fitted slider logo keeps its aspect ratio',
  );
  for (const template of ['classic', 'compact'] as const) {
    assertEqualOrThrow(
      gsV0Heights(sizedReceipt(template, '1.5')).totalHeight,
      60,
      `${template}: x1.5 slider logo height`,
    );
    assertEqualOrThrow(
      gsV0Heights(sizedReceipt(template, '0.5')).totalHeight,
      20,
      `${template}: x0.5 slider logo height`,
    );
  }

  console.log('--- 3c3. Typed logo width x height ---');
  const boxHeight = (bands: { heightDots: number }[]) =>
    bands.reduce((sum, band) => sum + band.heightDots, 0);
  const widthOnly = getLogoRasterBands(sizeLogoJson, 384, 200, 2, 0, false, { widthMm: 20 });
  assertEqualOrThrow(bandInkColumns(widthOnly), 160, '20 mm width prints 160 dots wide');
  assertEqualOrThrow(boxHeight(widthOnly), 100, 'width-only keeps the aspect ratio');
  const heightOnly = getLogoRasterBands(sizeLogoJson, 384, 200, 2, 0, false, { heightMm: 10 });
  assertEqualOrThrow(boxHeight(heightOnly), 80, '10 mm height prints 80 dots tall');
  assertEqualOrThrow(bandInkColumns(heightOnly), 128, 'height-only keeps the aspect ratio');
  const both = getLogoRasterBands(sizeLogoJson, 384, 200, 2, 0, false, {
    widthMm: 30,
    heightMm: 10,
  });
  assertEqualOrThrow(bandInkColumns(both), 240, 'typed width is exact');
  assertEqualOrThrow(boxHeight(both), 80, 'typed height is exact');
  const tooWide = getLogoRasterBands(sizeLogoJson, 384, 200, 2, 0, false, { widthMm: 100 });
  assertEqualOrThrow(bandInkColumns(tooWide), 384, 'typed width clamps to 58mm printable width');
  assertEqualOrThrow(boxHeight(tooWide), 240, 'clamped typed width keeps the aspect ratio');
  const tooTall = getLogoRasterBands(sizeLogoJson, 384, 200, 2, 0, false, { heightMm: 100 });
  assertEqualOrThrow(bandInkColumns(tooTall), 384, 'tall height-only logo stops at paper width');
  for (const template of ['classic', 'compact'] as const) {
    const typedReceipt = (box: Record<string, string>) =>
      formatReceipt(
        dummyOrder,
        dummyBill,
        {
          name: 'Flo Cafe',
          country: 'US',
          currency: 'USD',
          show_logo: true,
          receipt_logo: logoUrl,
          receipt_logo_raster: sizeLogoJson,
          show_name: true,
          ...box,
        },
        template,
        32,
      );
    assertEqualOrThrow(
      gsV0Heights(typedReceipt({ receipt_logo_width_mm: '20' })).totalHeight,
      100,
      `${template}: typed width reaches the printer`,
    );
    assertEqualOrThrow(
      Buffer.from(
        typedReceipt({ receipt_logo_width_mm: '0', receipt_logo_height_mm: '0' }),
      ).toString('hex'),
      Buffer.from(sizedReceipt(template)).toString('hex'),
      `${template}: zero width and height print like a shop with no typed size`,
    );
  }

  console.log('--- 3d. Logo offset setting ---');
  assertEqualOrThrow(receiptLogoOffsetDots(undefined), 0, 'unset offset is centred');
  assertEqualOrThrow(receiptLogoOffsetDots(2.5), 20, '2.5 mm is 20 dots');
  assertEqualOrThrow(receiptLogoOffsetDots('-1.5'), -12, 'stored string offset parses');
  assertEqualOrThrow(receiptLogoOffsetDots(99), 80, 'offset clamps to +10 mm');
  assertEqualOrThrow(receiptLogoOffsetDots('abc'), 0, 'garbage offset is centred');

  const centredLeft = bandInkLeft(getLogoRasterBands(sizeLogoJson, 384, 200, 1));
  assertEqualOrThrow(centredLeft, 160, 'small logo starts centred');
  assertEqualOrThrow(
    bandInkLeft(getLogoRasterBands(sizeLogoJson, 384, 200, 1, 40)),
    200,
    'positive offset moves the logo right',
  );
  assertEqualOrThrow(
    bandInkLeft(getLogoRasterBands(sizeLogoJson, 384, 200, 1, -40)),
    120,
    'negative offset moves the logo left',
  );
  const pushedRight = getLogoRasterBands(sizeLogoJson, 384, 200, 1, 10_000);
  assertEqualOrThrow(bandInkLeft(pushedRight), 320, 'offset clamps at the right paper edge');
  assertEqualOrThrow(bandInkColumns(pushedRight), 64, 'clamped logo keeps its full width');
  assertEqualOrThrow(
    bandInkLeft(getLogoRasterBands(sizeLogoJson, 384, 200, 1, -10_000)),
    0,
    'offset clamps at the left paper edge',
  );

  const offsetReceipt = (template: 'classic' | 'compact', offset?: number | string): Uint8Array =>
    formatReceipt(
      dummyOrder,
      dummyBill,
      {
        name: 'Flo Cafe',
        country: 'US',
        currency: 'USD',
        show_logo: true,
        receipt_logo: logoUrl,
        receipt_logo_raster: sizeLogoJson,
        show_name: true,
        ...(offset === undefined ? {} : { receipt_logo_offset_mm: offset }),
      },
      template,
      32,
    );
  for (const template of ['classic', 'compact'] as const) {
    const centred = Buffer.from(offsetReceipt(template)).toString('hex');
    assertEqualOrThrow(
      Buffer.from(offsetReceipt(template, '0')).toString('hex'),
      centred,
      `${template}: zero offset bytes match a shop with no saved offset`,
    );
    const shifted = offsetReceipt(template, '5');
    assertOrThrow(
      Buffer.from(shifted).toString('hex') !== centred,
      `${template}: a 5 mm offset changes the logo bytes`,
    );
    assertEqualOrThrow(
      gsV0Heights(shifted).totalHeight,
      80,
      `${template}: offset keeps the logo height`,
    );
  }

  console.log(
    '--- 3b. Non-Latin / Persian store header preserves logo bitmap during rasterization ---',
  );
  const rasterCaps = {
    ...GENERIC_THERMAL_CAPABILITIES,
    raster: {
      enabled: true,
      widthDots: 384,
      maxBandHeight: 200,
      modes: ['mixed', 'whole-receipt'] as const,
    },
  };
  const expectedLogoBands = getLogoRasterBands(
    decoupledLogoJson,
    384,
    200,
    RECEIPT_LOGO_PRINT_SCALE,
  );
  const expectedLogoGsV0 = Buffer.from(
    concatBytes(expectedLogoBands.map((band) => encodeGsV0Band(band, 200))),
  );

  for (const template of ['classic', 'compact'] as const) {
    const renderedRequests: RasterRenderRequest[] = [];
    const fakeRenderer = {
      async render(request: unknown) {
        const req = request as RasterRenderRequest;
        renderedRequests.push(req);
        return {
          version: 1 as const,
          requestId: req.requestId,
          ok: true as const,
          unit: {
            unitId: req.requestId,
            financial: req.financial,
            complete: true as const,
            bands: [
              {
                widthDots: req.widthDots,
                heightDots: 1,
                pixels: new Uint8Array(req.widthDots).fill(1),
              },
            ],
          },
        };
      },
    };

    const docLines = receiptDocumentLines(
      dummyOrder,
      dummyBill,
      {
        name: 'کافه شکلات',
        address: 'تهران، خیابان ولیعصر',
        country: 'IR',
        currency: 'IRR',
        show_logo: true,
        receipt_logo: logoUrl,
        receipt_logo_raster: decoupledLogoJson,
        show_name: true,
        show_address: true,
      },
      template,
      32,
      false,
      false,
      false,
      'fa',
      undefined,
      'full',
      rasterCaps,
    );
    assertOrThrow(docLines !== null, `receiptDocumentLines should return lines for ${template}`);

    const rasterResult = await renderUnsupportedRasterLines(
      fakeRenderer,
      docLines!.lines,
      rasterCaps,
      `test-${template}`,
      docLines!.rasterGroups,
    );
    assertEqualOrThrow(
      rasterResult.failures.length,
      0,
      `renderUnsupportedRasterLines should have 0 failures for ${template}`,
    );
    assertOrThrow(
      !renderedRequests.some(
        (req) => req.text.includes('[Logo]') || req.text.includes('RAW_BYTES'),
      ),
      `Raster renderer must never receive '[Logo]' or RAW_BYTES for ${template}`,
    );
    assertOrThrow(
      renderedRequests.some((req) => req.text.includes('کافه شکلات')),
      `Raster renderer should rasterize Persian store name for ${template}`,
    );

    const warnings: any[] = [];
    const finalBytes = buildEscPos(
      docLines!.lines,
      false,
      {
        cutMode: 'full',
        arabicShaping: false,
        columns: 32,
        language: 'fa',
        capabilities: rasterCaps,
        rasterUnits: rasterResult.units,
        rasterFailures: rasterResult.failures,
      },
      warnings,
    );
    assertOrThrow(
      finalBytes.includes(expectedLogoGsV0),
      `Final ESC/POS output for ${template} with Persian header must preserve exact logo GS v 0 bitmap bytes`,
    );
  }

  // Classic receipt with show_name: false (logo only in main) + Persian address in post
  {
    const renderedRequests: RasterRenderRequest[] = [];
    const fakeRenderer = {
      async render(request: unknown) {
        const req = request as RasterRenderRequest;
        renderedRequests.push(req);
        return {
          version: 1 as const,
          requestId: req.requestId,
          ok: true as const,
          unit: {
            unitId: req.requestId,
            financial: req.financial,
            complete: true as const,
            bands: [
              {
                widthDots: req.widthDots,
                heightDots: 1,
                pixels: new Uint8Array(req.widthDots).fill(1),
              },
            ],
          },
        };
      },
    };
    const docLines = receiptDocumentLines(
      dummyOrder,
      dummyBill,
      {
        name: 'کافه شکلات',
        address: 'تهران، خیابان ولیعصر',
        country: 'IR',
        currency: 'IRR',
        show_logo: true,
        receipt_logo: logoUrl,
        receipt_logo_raster: decoupledLogoJson,
        show_name: false,
        show_address: true,
      },
      'classic',
      32,
      false,
      false,
      false,
      'fa',
      undefined,
      'full',
      rasterCaps,
    );
    const rasterResult = await renderUnsupportedRasterLines(
      fakeRenderer,
      docLines!.lines,
      rasterCaps,
      'test-logo-only-main',
      docLines!.rasterGroups,
    );
    assertEqualOrThrow(
      rasterResult.failures.length,
      0,
      'renderUnsupportedRasterLines should succeed when business-header main has only logo and post has Persian address',
    );
    const finalBytes = buildEscPos(
      docLines!.lines,
      false,
      {
        cutMode: 'full',
        arabicShaping: false,
        columns: 32,
        language: 'fa',
        capabilities: rasterCaps,
        rasterUnits: rasterResult.units,
        rasterFailures: rasterResult.failures,
      },
      [],
    );
    assertOrThrow(
      finalBytes.includes(expectedLogoGsV0),
      'Logo GS v 0 bytes must remain intact when show_name is false and post has Persian address',
    );
  }

  console.log('--- 4. KOT kitchen tickets invariant: never print logo ---');
  const kotBytes = formatKOT(dummyOrder, dummyOrder.items, 'Kitchen', 32);

  let kotHasGsV0 = false;
  for (let i = 0; i < kotBytes.length - 4; i += 1) {
    if (
      kotBytes[i] === 0x1d &&
      kotBytes[i + 1] === 0x76 &&
      kotBytes[i + 2] === 0x30 &&
      kotBytes[i + 3] === 0x00
    ) {
      kotHasGsV0 = true;
      break;
    }
  }
  assertOrThrow(!kotHasGsV0, 'KOT ticket must never contain GS v 0 logo command');

  console.log('--- 5. Settings API validation and persistence ---');
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const app = createApp({ '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const authHeaders = owner.authHeader;

    // Reject oversized logo (> 250KB)
    const hugeLogo = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
    const rejectRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: hugeLogo,
      },
    });
    assertEqualOrThrow(
      rejectRes.status,
      400,
      'PUT /api/settings/business with oversized logo should return 400',
    );
    assertIncludesOrThrow(rejectRes.data.error, '250 KB', 'Error should mention 250 KB size limit');

    // Reject non-data URI
    const invalidUriRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: 'https://example.com/logo.png',
      },
    });
    assertEqualOrThrow(
      invalidUriRes.status,
      400,
      'PUT /api/settings/business with non-data URI should return 400',
    );

    // Reject malformed receipt_logo_raster
    const malformedRasterRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo_raster: '{"invalid":"json_structure"}',
      },
    });
    assertEqualOrThrow(
      malformedRasterRes.status,
      400,
      'PUT /api/settings/business with malformed raster should return 400',
    );

    // Accept valid logo and persist
    const acceptRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: logoUrl,
        receipt_logo_raster: rasterJson,
      },
    });
    assertEqualOrThrow(
      acceptRes.status,
      200,
      'PUT /api/settings/business with valid logo should succeed',
    );

    // Accept decoupled receipt_logo_raster (originalDataUrl: "") with bill_show_logo: true
    const acceptDecoupledRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: logoUrl,
        receipt_logo_raster: decoupledLogoJson,
        bill_show_logo: true,
      },
    });
    assertEqualOrThrow(
      acceptDecoupledRes.status,
      200,
      'PUT /api/settings/business with decoupled receipt_logo_raster should succeed',
    );

    // Fetch via GET /api/settings/business
    const getRes = await api(baseUrl, '/api/settings/business', {
      headers: authHeaders,
    });
    assertEqualOrThrow(getRes.status, 200, 'GET /api/settings/business should succeed');
    assertEqualOrThrow(
      getRes.data.receipt_logo,
      logoUrl,
      'GET should return persisted receipt_logo',
    );
    assertEqualOrThrow(
      getRes.data.receipt_logo_raster,
      decoupledLogoJson,
      'GET should return persisted decoupled receipt_logo_raster',
    );
    assertEqualOrThrow(
      getRes.data.bill_show_logo,
      true,
      'GET should return bill_show_logo enabled when saved with logo',
    );

    const defaultPrinting = await api(baseUrl, '/api/settings/printing', { headers: authHeaders });
    assertEqualOrThrow(
      defaultPrinting.data.bill_logo_size,
      'medium',
      'logo size defaults to medium',
    );
    const printingBody = {
      printer_trim_decimals: true,
      bill_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
      kot_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
      bill_show_name: true,
      bill_show_address: true,
      bill_show_phone: true,
      bill_show_tax_id: false,
      bill_show_tax_breakdown: true,
      bill_show_customer_name: true,
      bill_show_customer_phone: true,
      bill_show_table_number: true,
      bill_delivery_show_customer_phone_always: true,
    };
    const badSize = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: { ...printingBody, bill_logo_size: 'huge' },
    });
    assertEqualOrThrow(badSize.status, 400, 'unknown logo size is rejected');
    const largeSize = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: { ...printingBody, bill_logo_size: 'large' },
    });
    assertEqualOrThrow(largeSize.status, 200, 'logo size saves');
    const afterSize = await api(baseUrl, '/api/settings/printing', { headers: authHeaders });
    assertEqualOrThrow(afterSize.data.bill_logo_size, 'large', 'logo size reloads');
    const keepSize = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: printingBody,
    });
    assertEqualOrThrow(keepSize.status, 200, 'printing save without logo size succeeds');
    const businessSize = await api(baseUrl, '/api/settings/business', { headers: authHeaders });
    assertEqualOrThrow(
      businessSize.data.bill_logo_size,
      'large',
      'omitting logo size keeps the saved size',
    );
    assertEqualOrThrow(businessSize.data.bill_logo_offset_mm, 0, 'logo offset defaults to 0');
    for (const badOffset of [10.5, 0.3, '2']) {
      const badOffsetRes = await api(baseUrl, '/api/settings/printing', {
        method: 'PUT',
        headers: authHeaders,
        body: { ...printingBody, bill_logo_offset_mm: badOffset },
      });
      assertEqualOrThrow(badOffsetRes.status, 400, `logo offset ${badOffset} is rejected`);
    }
    const offsetRes = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: { ...printingBody, bill_logo_offset_mm: -2.5 },
    });
    assertEqualOrThrow(offsetRes.status, 200, 'logo offset saves');
    const afterOffset = await api(baseUrl, '/api/settings/printing', { headers: authHeaders });
    assertEqualOrThrow(afterOffset.data.bill_logo_offset_mm, -2.5, 'logo offset reloads');
    for (const badScale of [0.4, 3.1, 1.55]) {
      const badScaleRes = await api(baseUrl, '/api/settings/printing', {
        method: 'PUT',
        headers: authHeaders,
        body: { ...printingBody, bill_logo_size: badScale },
      });
      assertEqualOrThrow(badScaleRes.status, 400, `logo scale ${badScale} is rejected`);
    }
    const scaleRes = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: { ...printingBody, bill_logo_size: 1.7 },
    });
    assertEqualOrThrow(scaleRes.status, 200, 'logo slider scale saves');
    const afterScale = await api(baseUrl, '/api/settings/printing', { headers: authHeaders });
    assertEqualOrThrow(afterScale.data.bill_logo_size, 1.7, 'logo slider scale reloads');
    assertEqualOrThrow(afterScale.data.bill_logo_width_mm, 0, 'typed logo width defaults to 0');
    for (const badWidth of [4, 30.3, 101, '30']) {
      const badWidthRes = await api(baseUrl, '/api/settings/printing', {
        method: 'PUT',
        headers: authHeaders,
        body: { ...printingBody, bill_logo_width_mm: badWidth },
      });
      assertEqualOrThrow(badWidthRes.status, 400, `typed logo width ${badWidth} is rejected`);
    }
    const typedRes = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: { ...printingBody, bill_logo_width_mm: 30.5, bill_logo_height_mm: 12 },
    });
    assertEqualOrThrow(typedRes.status, 200, 'typed logo width and height save');
    const afterTyped = await api(baseUrl, '/api/settings/printing', { headers: authHeaders });
    assertEqualOrThrow(afterTyped.data.bill_logo_width_mm, 30.5, 'typed logo width reloads');
    assertEqualOrThrow(afterTyped.data.bill_logo_height_mm, 12, 'typed logo height reloads');

    // Update bill_show_logo toggle via PUT /api/settings/printing
    const toggleRes = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        printer_trim_decimals: true,
        bill_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        kot_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        bill_show_name: true,
        bill_show_address: true,
        bill_show_phone: true,
        bill_show_tax_id: false,
        bill_show_tax_breakdown: true,
        bill_show_customer_name: true,
        bill_show_customer_phone: true,
        bill_show_table_number: true,
        bill_delivery_show_customer_phone_always: true,
        bill_show_logo: true,
      },
    });
    assertEqualOrThrow(
      toggleRes.status,
      200,
      'PUT /api/settings/printing with bill_show_logo should succeed',
    );

    const getAfterToggle = await api(baseUrl, '/api/settings/business', {
      headers: authHeaders,
    });
    assertEqualOrThrow(
      getAfterToggle.data.bill_show_logo,
      true,
      'bill_show_logo should be true after toggle',
    );

    // Also update bill_show_logo toggle via PUT /api/settings/business
    const businessToggleRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        bill_show_logo: false,
      },
    });
    assertEqualOrThrow(
      businessToggleRes.status,
      200,
      'PUT /api/settings/business with bill_show_logo should succeed',
    );

    const getAfterBusinessToggle = await api(baseUrl, '/api/settings/business', {
      headers: authHeaders,
    });
    assertEqualOrThrow(
      getAfterBusinessToggle.data.bill_show_logo,
      false,
      'bill_show_logo should be false after business toggle',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  }

  console.log('✅ All receipt logo printing tests passed successfully!');
}

run().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
