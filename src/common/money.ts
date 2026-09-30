import { FinancialInvarianceError } from './errors.js';

export interface CurrencyDetails {
  code: string;
  symbol: string;
  decimals: number;
}

export const SUPPORTED_CURRENCIES: Record<string, CurrencyDetails> = {
  INR: { code: 'INR', symbol: '₹', decimals: 2 },
  USD: { code: 'USD', symbol: '$', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥', decimals: 0 },
};

export class Money {
  public readonly amountMinor: bigint;
  public readonly currency: string;

  private constructor(amountMinor: bigint, currency: string) {
    const normalizedCurrency = currency.toUpperCase();
    if (!SUPPORTED_CURRENCIES[normalizedCurrency]) {
      throw new FinancialInvarianceError(`Unsupported currency code: ${currency}`);
    }

    this.amountMinor = amountMinor;
    this.currency = normalizedCurrency;
    Object.freeze(this);
  }

  /**
   * Factory method using integer minor units (e.g. 10000n for ₹100.00)
   */
  public static fromMinor(amountMinor: bigint | number | string, currency: string): Money {
    const minorAsBigInt = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
    return new Money(minorAsBigInt, currency);
  }

  /**
   * Factory method creating Money from decimal string representation (e.g. "100.50", INR)
   * Avoids float math by parsing integer and decimal substrings directly.
   */
  public static fromDecimalString(amountStr: string, currency: string): Money {
    const normalizedCurrency = currency.toUpperCase();
    const currencyInfo = SUPPORTED_CURRENCIES[normalizedCurrency];
    if (!currencyInfo) {
      throw new FinancialInvarianceError(`Unsupported currency code: ${currency}`);
    }

    const trimmed = amountStr.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new FinancialInvarianceError(`Invalid decimal string format for money: ${amountStr}`);
    }

    const isNegative = trimmed.startsWith('-');
    const cleanStr = isNegative ? trimmed.slice(1) : trimmed;
    const parts = cleanStr.split('.');
    const integerPart = parts[0] || '0';
    let fractionPart = parts[1] || '';

    if (fractionPart.length > currencyInfo.decimals) {
      throw new FinancialInvarianceError(
        `Fractional units exceed maximum precision for currency ${currency} (${currencyInfo.decimals} decimals allowed)`
      );
    }

    fractionPart = fractionPart.padEnd(currencyInfo.decimals, '0');
    const combinedString = `${integerPart}${fractionPart}`;
    const value = BigInt(combinedString);

    return new Money(isNegative ? -value : value, currency);
  }

  public static zero(currency: string): Money {
    return new Money(0n, currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  public multiply(multiplier: number | bigint): Money {
    if (typeof multiplier === 'number') {
      if (!Number.isInteger(multiplier)) {
        throw new FinancialInvarianceError('Multiplier must be an integer to avoid floating-point errors');
      }
      return new Money(this.amountMinor * BigInt(multiplier), this.currency);
    }
    return new Money(this.amountMinor * multiplier, this.currency);
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountMinor > other.amountMinor;
  }

  public greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountMinor >= other.amountMinor;
  }

  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountMinor < other.amountMinor;
  }

  public isZero(): boolean {
    return this.amountMinor === 0n;
  }

  public isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  public isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  public toDecimal(): string {
    const currencyInfo = SUPPORTED_CURRENCIES[this.currency]!;
    const isNegative = this.amountMinor < 0n;
    const absValue = isNegative ? -this.amountMinor : this.amountMinor;
    const str = absValue.toString();

    if (currencyInfo.decimals === 0) {
      return `${isNegative ? '-' : ''}${str}`;
    }

    const padded = str.padStart(currencyInfo.decimals + 1, '0');
    const integerPart = padded.slice(0, -currencyInfo.decimals);
    const fractionPart = padded.slice(-currencyInfo.decimals);

    return `${isNegative ? '-' : ''}${integerPart}.${fractionPart}`;
  }

  public format(): string {
    const info = SUPPORTED_CURRENCIES[this.currency]!;
    return `${info.symbol}${this.toDecimal()} ${info.code}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new FinancialInvarianceError(
        `Currency mismatch: cannot perform operation between ${this.currency} and ${other.currency}`
      );
    }
  }
}

export function formatMinorToMajor(amountMinor: bigint | number | string, currency: string): string {
  const money = Money.fromMinor(amountMinor, currency);
  const info = SUPPORTED_CURRENCIES[money.currency]!;
  const decimalStr = money.toDecimal();
  const [intPart, fracPart] = decimalStr.split('.');
  const formattedInt = (intPart || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formattedDec = fracPart !== undefined ? `.${fracPart}` : '';
  return `${info.symbol}${formattedInt}${formattedDec} ${info.code}`;
}

