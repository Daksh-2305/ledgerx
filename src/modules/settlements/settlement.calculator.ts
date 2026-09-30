import { FinancialInvarianceError } from '../../common/errors.js';
import { BatchCalculationResult, SettlementCalculationItem } from './settlement.types.js';

export interface SettlementCalculatorOptions {
  feeBps: number; // e.g., 200 = 2.00%
  adjustmentAmountMinor?: bigint;
}

export class SettlementCalculator {
  /**
   * Calculates net settlement amounts for a set of eligible and excluded transactions.
   * Strictly enforces integer minor units arithmetic (BigInt) with zero floating-point math.
   */
  public static calculateBatch(
    items: Array<{
      paymentId: string;
      merchantId: string;
      currency: string;
      capturedAmountMinor: bigint;
      refundedAmountMinor: bigint;
      isEligible: boolean;
      exclusionReason?: string;
      ledgerTransactionId?: string | null;
    }>,
    options: SettlementCalculatorOptions
  ): BatchCalculationResult {
    let totalGross = 0n;
    let totalRefund = 0n;
    let totalFee = 0n;
    const adjustment = options.adjustmentAmountMinor || 0n;

    const feeBpsBigInt = BigInt(options.feeBps);
    const calculatedItems: SettlementCalculationItem[] = [];

    for (const item of items) {
      if (!item.isEligible) {
        calculatedItems.push({
          paymentId: item.paymentId,
          merchantId: item.merchantId,
          currency: item.currency,
          capturedAmountMinor: item.capturedAmountMinor,
          refundedAmountMinor: item.refundedAmountMinor,
          feeAmountMinor: 0n,
          netAmountMinor: 0n,
          isEligible: false,
          exclusionReason: item.exclusionReason,
          ledgerTransactionId: item.ledgerTransactionId,
        });
        continue;
      }

      const gross = item.capturedAmountMinor;
      const refund = item.refundedAmountMinor;

      if (gross < 0n) {
        throw new FinancialInvarianceError(
          `Gross captured amount cannot be negative for payment ${item.paymentId}: ${gross}`
        );
      }
      if (refund < 0n) {
        throw new FinancialInvarianceError(
          `Refund amount cannot be negative for payment ${item.paymentId}: ${refund}`
        );
      }
      if (refund > gross) {
        throw new FinancialInvarianceError(
          `Refund amount (${refund}) exceeds gross captured amount (${gross}) for payment ${item.paymentId}`
        );
      }

      // Net captured before fees = gross - refund
      const netCaptured = gross - refund;

      // Fee calculated strictly in integer minor units:
      // fee = (gross * feeBps) / 10000n
      const itemFee = (gross * feeBpsBigInt) / 10000n;

      const itemNet = netCaptured - itemFee;
      if (itemNet < 0n) {
        throw new FinancialInvarianceError(
          `Computed item net settlement amount cannot be negative for payment ${item.paymentId}: ${itemNet}`
        );
      }

      totalGross += gross;
      totalRefund += refund;
      totalFee += itemFee;

      calculatedItems.push({
        paymentId: item.paymentId,
        merchantId: item.merchantId,
        currency: item.currency,
        capturedAmountMinor: gross,
        refundedAmountMinor: refund,
        feeAmountMinor: itemFee,
        netAmountMinor: itemNet,
        isEligible: true,
        ledgerTransactionId: item.ledgerTransactionId,
      });
    }

    const netAmountMinor = totalGross - totalRefund - totalFee + adjustment;

    // Validate Invariants
    this.validateInvariants({
      grossAmountMinor: totalGross,
      refundAmountMinor: totalRefund,
      feeAmountMinor: totalFee,
      adjustmentAmountMinor: adjustment,
      netAmountMinor,
      items: calculatedItems,
    });

    const eligibleCount = calculatedItems.filter((i) => i.isEligible).length;

    return {
      grossAmountMinor: totalGross,
      refundAmountMinor: totalRefund,
      feeAmountMinor: totalFee,
      adjustmentAmountMinor: adjustment,
      netAmountMinor,
      recordCount: eligibleCount,
      items: calculatedItems,
    };
  }

  /**
   * Verifies all financial invariants:
   * 1. gross >= 0, refunds >= 0, fees >= 0, net >= 0
   * 2. SUM(eligible records) == batch totals
   * 3. net = gross - refunds - fees + adjustments
   */
  public static validateInvariants(data: {
    grossAmountMinor: bigint;
    refundAmountMinor: bigint;
    feeAmountMinor: bigint;
    adjustmentAmountMinor: bigint;
    netAmountMinor: bigint;
    items: SettlementCalculationItem[];
  }): void {
    if (data.grossAmountMinor < 0n) {
      throw new FinancialInvarianceError(
        `Invariant violation: gross amount cannot be negative (${data.grossAmountMinor})`
      );
    }
    if (data.refundAmountMinor < 0n) {
      throw new FinancialInvarianceError(
        `Invariant violation: refund amount cannot be negative (${data.refundAmountMinor})`
      );
    }
    if (data.feeAmountMinor < 0n) {
      throw new FinancialInvarianceError(
        `Invariant violation: fee amount cannot be negative (${data.feeAmountMinor})`
      );
    }
    if (data.netAmountMinor < 0n) {
      throw new FinancialInvarianceError(
        `Invariant violation: net settlement amount cannot be negative (${data.netAmountMinor})`
      );
    }

    // Mathematical formula check: net = gross - refund - fee + adjustment
    const expectedNet =
      data.grossAmountMinor -
      data.refundAmountMinor -
      data.feeAmountMinor +
      data.adjustmentAmountMinor;

    if (data.netAmountMinor !== expectedNet) {
      throw new FinancialInvarianceError(
        `Invariant violation: net settlement (${data.netAmountMinor}) does not equal gross (${data.grossAmountMinor}) - refunds (${data.refundAmountMinor}) - fees (${data.feeAmountMinor}) + adjustments (${data.adjustmentAmountMinor}) = ${expectedNet}`
      );
    }

    // Verify SUM of eligible records matches batch totals
    let sumGross = 0n;
    let sumRefund = 0n;
    let sumFee = 0n;
    let sumNet = 0n;

    for (const item of data.items) {
      if (item.isEligible) {
        sumGross += item.capturedAmountMinor;
        sumRefund += item.refundedAmountMinor;
        sumFee += item.feeAmountMinor;
        sumNet += item.netAmountMinor;
      }
    }

    if (sumGross !== data.grossAmountMinor) {
      throw new FinancialInvarianceError(
        `Invariant violation: sum of record gross amounts (${sumGross}) does not match batch gross amount (${data.grossAmountMinor})`
      );
    }
    if (sumRefund !== data.refundAmountMinor) {
      throw new FinancialInvarianceError(
        `Invariant violation: sum of record refunds (${sumRefund}) does not match batch refund amount (${data.refundAmountMinor})`
      );
    }
    if (sumFee !== data.feeAmountMinor) {
      throw new FinancialInvarianceError(
        `Invariant violation: sum of record fees (${sumFee}) does not match batch fee amount (${data.feeAmountMinor})`
      );
    }
    if (sumNet + data.adjustmentAmountMinor !== data.netAmountMinor) {
      throw new FinancialInvarianceError(
        `Invariant violation: sum of record net amounts + adjustment (${sumNet + data.adjustmentAmountMinor}) does not match batch net amount (${data.netAmountMinor})`
      );
    }
  }
}
