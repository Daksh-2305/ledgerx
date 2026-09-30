import { describe, it, expect } from 'vitest';
import { Money } from './money.js';
import { FinancialInvarianceError } from './errors.js';

describe('Money Value Object', () => {
  it('creates money from integer minor units', () => {
    const m = Money.fromMinor(10050n, 'INR');
    expect(m.amountMinor).toBe(10050n);
    expect(m.currency).toBe('INR');
    expect(m.toDecimal()).toBe('100.50');
    expect(m.format()).toBe('₹100.50 INR');
  });

  it('creates money from decimal string safely without float errors', () => {
    const m = Money.fromDecimalString('99.99', 'USD');
    expect(m.amountMinor).toBe(9999n);
    expect(m.currency).toBe('USD');
    expect(m.toDecimal()).toBe('99.99');
    expect(m.format()).toBe('$99.99 USD');
  });

  it('correctly handles zero-decimal currencies like JPY', () => {
    const jpy = Money.fromMinor(5000n, 'JPY');
    expect(jpy.toDecimal()).toBe('5000');
    expect(jpy.format()).toBe('¥5000 JPY');
  });

  it('performs exact addition and subtraction without precision drift', () => {
    const a = Money.fromMinor(1000n, 'INR'); // ₹10.00
    const b = Money.fromMinor(2050n, 'INR'); // ₹20.50

    const sum = a.add(b);
    expect(sum.amountMinor).toBe(3050n);
    expect(sum.toDecimal()).toBe('30.50');

    const diff = b.subtract(a);
    expect(diff.amountMinor).toBe(1050n);
    expect(diff.toDecimal()).toBe('10.50');
  });

  it('rejects addition between different currencies', () => {
    const inr = Money.fromMinor(1000n, 'INR');
    const usd = Money.fromMinor(1000n, 'USD');

    expect(() => inr.add(usd)).toThrow(FinancialInvarianceError);
    expect(() => inr.subtract(usd)).toThrow(FinancialInvarianceError);
  });

  it('rejects floating point multipliers to avoid precision loss', () => {
    const m = Money.fromMinor(1000n, 'USD');
    expect(() => m.multiply(1.5)).toThrow(FinancialInvarianceError);
  });

  it('supports integer multiplication', () => {
    const m = Money.fromMinor(2500n, 'EUR');
    const multiplied = m.multiply(4);
    expect(multiplied.amountMinor).toBe(10000n);
    expect(multiplied.toDecimal()).toBe('100.00');
  });

  it('compares amounts correctly', () => {
    const small = Money.fromMinor(500n, 'USD');
    const large = Money.fromMinor(1000n, 'USD');

    expect(large.greaterThan(small)).toBe(true);
    expect(small.lessThan(large)).toBe(true);
    expect(small.equals(Money.fromMinor(500n, 'USD'))).toBe(true);
  });
});
