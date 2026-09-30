import { describe, it, expect, beforeEach } from 'vitest';
import { LedgerService } from './ledger.service.js';
import { InMemoryLedgerRepository } from './ledger.repository.js';
import { FinancialInvarianceError, NotFoundError } from '../../common/errors.js';

describe('LedgerService (Double-Entry Accounting Core)', () => {
  let repository: InMemoryLedgerRepository;
  let service: LedgerService;

  let cashAccount: { id: string; code: string };
  let receivableAccount: { id: string; code: string };
  let clearingAccount: { id: string; code: string };

  beforeEach(async () => {
    repository = new InMemoryLedgerRepository();
    service = new LedgerService(repository);

    // Setup chart of accounts
    const a1 = await service.getOrCreateAccount({
      code: 'MERCHANT_CASH',
      name: 'Merchant Cash Account',
      type: 'ASSET',
      currency: 'INR',
    });
    cashAccount = { id: a1.id, code: a1.code };

    const a2 = await service.getOrCreateAccount({
      code: 'MERCHANT_RECEIVABLE',
      name: 'Merchant Settlement Receivable',
      type: 'ASSET',
      currency: 'INR',
    });
    receivableAccount = { id: a2.id, code: a2.code };

    const a3 = await service.getOrCreateAccount({
      code: 'PAYMENT_CLEARING',
      name: 'Platform Payment Clearing',
      type: 'CLEARING',
      currency: 'INR',
    });
    clearingAccount = { id: a3.id, code: a3.code };
  });

  describe('Financial Balance Invariant', () => {
    it('successfully posts a balanced 2-entry transaction (Debits == Credits)', async () => {
      const tx = await service.createLedgerTransaction({
        referenceType: 'PAYMENT',
        referenceId: 'ref-balanced-001',
        transactionType: 'CAPTURE',
        currency: 'INR',
        description: 'Standard balanced capture',
        entries: [
          { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 10000n }, // ₹100.00
          { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 10000n }, // ₹100.00
        ],
      });

      expect(tx.id).toBeDefined();
      expect(tx.entries.length).toBe(2);
      expect(tx.referenceId).toBe('ref-balanced-001');

      // Verify persistence
      const saved = await service.getTransactionById(tx.id);
      expect(saved.entries.length).toBe(2);
    });

    it('rejects an unbalanced transaction (Debits != Credits) and persists nothing', async () => {
      // Debits = 10000, Credits = 9000 (Difference = 1000)
      await expect(
        service.createLedgerTransaction({
          referenceType: 'PAYMENT',
          referenceId: 'ref-unbalanced-001',
          transactionType: 'CAPTURE',
          currency: 'INR',
          entries: [
            { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 10000n },
            { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 9000n },
          ],
        })
      ).rejects.toThrow(FinancialInvarianceError);

      // Verify that NO transaction or entries were saved
      const transactions = await repository.findTransactions({ page: 1, limit: 10 });
      expect(transactions.total).toBe(0);
    });

    it('supports multiple entries that balance in total (Debit ₹100 = Credit ₹60 + Credit ₹40)', async () => {
      const feeAccount = await service.getOrCreateAccount({
        code: 'PLATFORM_FEE',
        name: 'Platform Processing Fee Revenue',
        type: 'REVENUE',
        currency: 'INR',
      });

      const tx = await service.createLedgerTransaction({
        referenceType: 'PAYMENT',
        referenceId: 'ref-split-001',
        transactionType: 'CAPTURE',
        currency: 'INR',
        entries: [
          { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 10000n }, // ₹100
          { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 6000n }, // ₹60
          { accountId: feeAccount.id, entryType: 'CREDIT', amountMinor: 4000n }, // ₹40
        ],
      });

      expect(tx.entries.length).toBe(3);
      const totalDebits = tx.entries
        .filter((e) => e.entryType === 'DEBIT')
        .reduce((sum, e) => sum + e.amountMinor, 0n);
      const totalCredits = tx.entries
        .filter((e) => e.entryType === 'CREDIT')
        .reduce((sum, e) => sum + e.amountMinor, 0n);

      expect(totalDebits).toBe(10000n);
      expect(totalCredits).toBe(10000n);
      expect(totalDebits).toBe(totalCredits);
    });

    it('rejects entries with negative or zero amounts', async () => {
      await expect(
        service.createLedgerTransaction({
          referenceType: 'PAYMENT',
          referenceId: 'ref-negative-001',
          transactionType: 'CAPTURE',
          currency: 'INR',
          entries: [
            { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: -5000n },
            { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: -5000n },
          ],
        })
      ).rejects.toThrow(FinancialInvarianceError);

      await expect(
        service.createLedgerTransaction({
          referenceType: 'PAYMENT',
          referenceId: 'ref-zero-001',
          transactionType: 'CAPTURE',
          currency: 'INR',
          entries: [
            { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 0n },
            { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 0n },
          ],
        })
      ).rejects.toThrow(FinancialInvarianceError);
    });

    it('rejects transactions with fewer than 2 entries', async () => {
      await expect(
        service.createLedgerTransaction({
          referenceType: 'PAYMENT',
          referenceId: 'ref-single-001',
          transactionType: 'CAPTURE',
          currency: 'INR',
          entries: [
            { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 1000n },
          ],
        })
      ).rejects.toThrow(FinancialInvarianceError);
    });
  });

  describe('Account Balance Derivation', () => {
    it('accurately derives account balance from historical ledger entries', async () => {
      // Transaction 1: Add ₹500 to Cash (Debit Cash ₹500, Credit Clearing ₹500)
      await service.createLedgerTransaction({
        referenceType: 'PAYMENT',
        referenceId: 'ref-bal-001',
        transactionType: 'CAPTURE',
        currency: 'INR',
        entries: [
          { accountId: cashAccount.id, entryType: 'DEBIT', amountMinor: 50000n },
          { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 50000n },
        ],
      });

      // Transaction 2: Add another ₹200 to Cash (Debit Cash ₹200, Credit Clearing ₹200)
      await service.createLedgerTransaction({
        referenceType: 'PAYMENT',
        referenceId: 'ref-bal-002',
        transactionType: 'CAPTURE',
        currency: 'INR',
        entries: [
          { accountId: cashAccount.id, entryType: 'DEBIT', amountMinor: 20000n },
          { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 20000n },
        ],
      });

      // Transaction 3: Spend ₹150 from Cash (Debit Receivable ₹150, Credit Cash ₹150)
      await service.createLedgerTransaction({
        referenceType: 'SETTLEMENT',
        referenceId: 'ref-bal-003',
        transactionType: 'SETTLEMENT',
        currency: 'INR',
        entries: [
          { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 15000n },
          { accountId: cashAccount.id, entryType: 'CREDIT', amountMinor: 15000n },
        ],
      });

      // Cash Account (ASSET): Debits (50000 + 20000) = 70000, Credits = 15000.
      // Net Balance = 70000 - 15000 = 55000 (₹550.00)
      const cashSummary = await service.getAccountWithBalance(cashAccount.id);
      expect(cashSummary.totalDebitsMinor).toBe(70000n);
      expect(cashSummary.totalCreditsMinor).toBe(15000n);
      expect(cashSummary.netBalanceMinor).toBe(55000n);
      expect(cashSummary.entryCount).toBe(3);

      // Clearing Account (CLEARING): Credits (50000 + 20000) = 70000, Debits = 0.
      // Net Balance = 70000 (₹700.00)
      const clearingSummary = await service.getAccountWithBalance(clearingAccount.id);
      expect(clearingSummary.totalCreditsMinor).toBe(70000n);
      expect(clearingSummary.totalDebitsMinor).toBe(0n);
      expect(clearingSummary.netBalanceMinor).toBe(70000n);
    });
  });

  describe('Idempotency & Duplicate Financial Events', () => {
    it('returns existing transaction idempotently when the same reference is processed twice', async () => {
      const input = {
        referenceType: 'PAYMENT',
        referenceId: 'ref-idempotent-001',
        transactionType: 'CAPTURE' as const,
        currency: 'INR',
        entries: [
          { accountId: receivableAccount.id, entryType: 'DEBIT' as const, amountMinor: 5000n },
          { accountId: clearingAccount.id, entryType: 'CREDIT' as const, amountMinor: 5000n },
        ],
      };

      const first = await service.createLedgerTransaction(input);
      const second = await service.createLedgerTransaction(input);

      expect(first.id).toBe(second.id);
      expect(second.entries.length).toBe(2);

      // Verify that total entries in the ledger for this account remains exactly 1 debit and 1 credit
      const entries = await service.listAccountEntries(receivableAccount.id, 1, 10);
      expect(entries.total).toBe(1);
    });
  });

  describe('Ledger Integrity Verification', () => {
    it('reports ledger as healthy when all transactions are balanced', async () => {
      await service.createLedgerTransaction({
        referenceType: 'PAYMENT',
        referenceId: 'ref-audit-001',
        transactionType: 'CAPTURE',
        currency: 'INR',
        entries: [
          { accountId: receivableAccount.id, entryType: 'DEBIT', amountMinor: 12000n },
          { accountId: clearingAccount.id, entryType: 'CREDIT', amountMinor: 12000n },
        ],
      });

      const report = await service.verifyLedgerIntegrity();
      expect(report.healthy).toBe(true);
      expect(report.total_transactions).toBe(1);
      expect(report.balanced_transactions).toBe(1);
      expect(report.unbalanced_transactions).toBe(0);
      expect(report.orphan_entries).toBe(0);
      expect(report.duplicate_financial_references).toBe(0);
    });
  });
});
