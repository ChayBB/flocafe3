import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCountryByCode } from '../main/countries';
import { dialCodeFor } from '../frontend/src/lib/phone';

test('IR country profile properties', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir, 'IR country profile should exist');
  assert.equal(ir.code, 'IR');
  assert.equal(ir.locale, 'fa-IR');
  assert.equal(ir.currency, 'IRR');
  assert.equal(ir.timezone, 'Asia/Tehran');
  assert.equal(dialCodeFor(ir.code), '+98');
  assert.equal(ir.taxIdLabel, 'Economic Code');
  assert.equal(ir.taxName, 'VAT');
  assert.equal(ir.taxIdFormat, undefined, 'No tax ID format should be enforced for IR');
});
