import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, splitInclusive, taxRate } from '../src/tax.ts';

test('splits a tax-inclusive total by currency', () => {
  assert.deepEqual(splitInclusive(10825, 'USD'), { subtotal: 10000, tax: 825, rate: 0.0825 });
  assert.deepEqual(splitInclusive(12000, 'EUR'), { subtotal: 10000, tax: 2000, rate: 0.2 });
  assert.deepEqual(splitInclusive(0, 'GBP'), { subtotal: 0, tax: 0, rate: 0.2 });
});

test('subtotal plus tax always equals the total, for any total', () => {
  for (const currency of ['USD', 'EUR', 'GBP']) {
    for (let total = 0; total < 5000; total += 7) {
      const s = splitInclusive(total, currency);
      assert.equal(s.subtotal + s.tax, total);
      assert.ok(s.tax >= 0 && s.subtotal >= 0);
    }
  }
});

test('a currency without a tax rule is an error, not zero tax', () => {
  assert.throws(() => taxRate('JPY'), /no tax rule/);
});

test('formats minor units', () => {
  assert.equal(formatMoney(12345, 'USD'), 'USD 123.45');
  assert.equal(formatMoney(5, 'EUR'), 'EUR 0.05');
});
