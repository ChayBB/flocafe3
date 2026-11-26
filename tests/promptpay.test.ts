import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptPayPayload,
  crc16Ccitt,
  normalizePromptPayAccount,
  parsePromptPayAccount,
} from '../main/lib/promptpay';

test('crc16Ccitt matches the CCITT-FALSE check value', () => {
  assert.equal(crc16Ccitt('123456789'), '29B1');
});

test('parsePromptPayAccount classifies phone, national id and e-wallet', () => {
  assert.deepEqual(parsePromptPayAccount('081-234-5678'), {
    kind: 'phone',
    value: '0066812345678',
  });
  assert.deepEqual(parsePromptPayAccount('1234567890123'), {
    kind: 'national_id',
    value: '1234567890123',
  });
  assert.deepEqual(parsePromptPayAccount('004999000000001'), {
    kind: 'ewallet',
    value: '004999000000001',
  });
  assert.equal(parsePromptPayAccount('12345'), null);
  assert.equal(parsePromptPayAccount('abc'), null);
  assert.equal(parsePromptPayAccount(undefined), null);
});

test('static payload has no amount and a valid checksum', () => {
  const target = parsePromptPayAccount('0812345678')!;
  const payload = buildPromptPayPayload(target);
  assert.ok(payload.startsWith('000201010211'));
  assert.ok(payload.includes('0016A00000067701011101130066812345678530376458'.slice(0, 44)));
  assert.ok(payload.includes('01130066812345678'));
  assert.ok(!payload.includes('5404'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('dynamic payload carries the bill amount to two decimals', () => {
  const target = parsePromptPayAccount('0812345678')!;
  const payload = buildPromptPayPayload(target, 267.5);
  assert.ok(payload.startsWith('000201010212'));
  assert.ok(payload.includes('5303764'));
  assert.ok(payload.includes('5406267.50'));
  assert.ok(payload.includes('5802TH'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('a national ID or tax ID payload uses PromptPay sub-tag 02 and never the reserved bank-account tag', () => {
  const target = parsePromptPayAccount('0105556000000')!;
  assert.equal(target.kind, 'national_id');
  const payload = buildPromptPayPayload(target, 100);
  assert.ok(payload.includes('29370016A000000677010111' + '02130105556000000'));
  assert.ok(!payload.includes('A00000067701011104'));
  assert.ok(payload.includes('5406100.00'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('crc16Ccitt matches published PromptPay reference payloads', () => {
  assert.equal(
    crc16Ccitt('00020101021129370016A000000677010111011300660000000005802TH53037646304'),
    '8956',
  );
  assert.equal(
    crc16Ccitt('00020101021229370016A000000677010111011300660000000005802TH530376454044.226304'),
    'E469',
  );
});

test('a phone number is accepted with separators or a +66 prefix and encodes under sub-tag 01', () => {
  for (const raw of [
    '0812345678',
    '081 234 5678',
    '081-234-5678',
    '(081) 234.5678',
    '+66812345678',
    '+66 81 234 5678',
    '66812345678',
  ]) {
    assert.deepEqual(parsePromptPayAccount(raw), { kind: 'phone', value: '0066812345678' }, raw);
    assert.equal(normalizePromptPayAccount(raw), '0812345678', raw);
  }
  const payload = buildPromptPayPayload(parsePromptPayAccount('+66 81 234 5678')!, 50);
  assert.ok(payload.includes('29370016A000000677010111' + '01130066812345678'));
  assert.equal(payload.slice(-4), crc16Ccitt(payload.slice(0, -4)));
});

test('an e-wallet ID encodes under sub-tag 03', () => {
  const target = parsePromptPayAccount('004-999-000000001')!;
  assert.deepEqual(target, { kind: 'ewallet', value: '004999000000001' });
  assert.equal(normalizePromptPayAccount('004-999-000000001'), '004999000000001');
  const payload = buildPromptPayPayload(target);
  assert.ok(payload.includes('29390016A000000677010111' + '0315004999000000001'));
});

test('normalizePromptPayAccount keeps a 13-digit ID and rejects anything else', () => {
  assert.equal(normalizePromptPayAccount('1-2345-67890-12-3'), '1234567890123');
  for (const raw of [
    '',
    '12345',
    '081234567',
    '08123456789',
    '1812345678',
    '+1 202 555 0100',
    '08l2345678',
    'abc',
    undefined,
    812345678,
  ]) {
    assert.equal(normalizePromptPayAccount(raw), null, String(raw));
    assert.equal(parsePromptPayAccount(raw), null, String(raw));
  }
});
