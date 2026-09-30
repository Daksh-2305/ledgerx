import crypto from 'node:crypto';
import {
  ILedgerRepository,
  ValidatedEntryData,
  ValidatedTransactionData,
} from './ledger.repository.js';
import {
  AccountBalanceSummary,
  CreateLedgerTransactionInput,
  LedgerAccountEntity,
  LedgerEntryEntity,
  LedgerIntegrityReport,
  LedgerTransactionEntity,
  LedgerTransactionFilter,
} from './ledger.types.js';
import {
  NotFoundError,
  FinancialInvarianceError,
  ValidationError,
} from '../../common/errors.js';
import { SUPPORTED_CURRENCIES } from '../../common/money.js';
import { logger } from '../../common/logger.js';
import { PaymentEntity, RefundEntity } from '../payments/payment.repository.js';
import {
  RedisCacheService,
  getRedisCacheService,
} from '../../infra/redis/redis-cache.service.js';
import { RedisKeys } from '../../infra/redis/redis.keys.js';
import { config } from '../../config/index.js';

export interface RequestContext {
  actorId?: string;
  correlationId?: string;
  requestId?: string;
}

export class LedgerService {
  constructor(
    private readonly repository: ILedgerRepository,
    private readonly cacheService: RedisCacheService = getRedisCacheService()
  ) {}

  /**
   * Core Double-Entry Transaction Creator
   * Enforces:
   * 1. Entries >= 2
   * 2. Positive amounts (no zero or negative entries)
   * 3. Currency uniformity
   * 4. TOTAL DEBITS == TOTAL CREDITS
   * 5. Reference idempotency
   */
  public async createLedgerTransaction(
    input: CreateLedgerTransactionInput,
    context: RequestContext = {}
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }> {
    if (!input.entries || input.entries.length < 2) {
      throw new FinancialInvarianceError(
        'A double-entry ledger transaction must contain at least 2 entries (one debit, one credit)'
      );
    }

    const currencyNormalized = input.currency.toUpperCase();
    if (!SUPPORTED_CURRENCIES[currencyNormalized]) {
      throw new FinancialInvarianceError(`Unsupported ledger currency: ${input.currency}`);
    }

    // 1. Idempotency Check: if reference already recorded, return it
    const existing = await this.repository.findTransactionByReference(
      input.referenceType,
      input.referenceId
    );
    if (existing) {
      logger.info(
        `Ledger transaction for reference ${input.referenceType}:${input.referenceId} already exists. Returning idempotently.`,
        {
          correlationId: context.correlationId,
          event: 'ledger.idempotent_hit',
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          transactionId: existing.id,
        }
      );
      return existing;
    }

    let totalDebits = 0n;
    let totalCredits = 0n;
    const validatedEntries: ValidatedEntryData[] = [];

    // 2. Validate all accounts and entries
    for (const [index, entry] of input.entries.entries()) {
      const amountMinor =
        typeof entry.amountMinor === 'bigint' ? entry.amountMinor : BigInt(entry.amountMinor);

      if (amountMinor <= 0n) {
        throw new FinancialInvarianceError(
          `Entry at index ${index} has non-positive amount (${amountMinor}). All ledger entries must have amount > 0.`
        );
      }

      const account = await this.repository.findAccountById(entry.accountId);
      if (!account) {
        throw new NotFoundError('LedgerAccount', entry.accountId);
      }

      if (account.currency !== currencyNormalized) {
        throw new FinancialInvarianceError(
          `Currency mismatch for account '${account.code}': expected ${currencyNormalized}, got ${account.currency}`
        );
      }

      if (entry.entryType === 'DEBIT') {
        totalDebits += amountMinor;
      } else if (entry.entryType === 'CREDIT') {
        totalCredits += amountMinor;
      } else {
        throw new ValidationError(`Invalid entryType '${entry.entryType}'. Must be DEBIT or CREDIT.`);
      }

      validatedEntries.push({
        id: crypto.randomUUID(),
        accountId: entry.accountId,
        entryType: entry.entryType,
        amountMinor,
        currency: currencyNormalized,
      });
    }

    // 3. Strict Balance Check: TOTAL DEBITS == TOTAL CREDITS
    if (totalDebits !== totalCredits) {
      throw new FinancialInvarianceError(
        `Ledger transaction is unbalanced: Total Debits (${totalDebits}) does not equal Total Credits (${totalCredits}). Transaction rejected.`
      );
    }

    const txData: ValidatedTransactionData = {
      id: crypto.randomUUID(),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      transactionType: input.transactionType,
      currency: currencyNormalized,
      description: input.description,
      entries: validatedEntries,
      actorId: context.actorId || input.actorId,
      correlationId: context.correlationId || input.correlationId,
    };

    const result = await this.repository.createBalancedTransaction(txData);

    // Invalidate affected account balance caches
    for (const entry of validatedEntries) {
      await this.cacheService.del(RedisKeys.accountCache(entry.accountId));
    }

    logger.info(`Double-entry ledger transaction posted: ${result.id}`, {
      correlationId: context.correlationId,
      requestId: context.requestId,
      event: 'ledger.transaction_posted',
      status: 'SUCCESS',
      transactionId: result.id,
      referenceType: result.referenceType,
      referenceId: result.referenceId,
      transactionType: result.transactionType,
      totalAmountMinor: Number(totalDebits),
      currency: result.currency,
      entriesCount: result.entries.length,
    });

    return result;
  }

  /**
   * Connects Payment Capture to the Double-Entry Ledger
   * Debits Merchant Receivable and Credits Payment Clearing
   */
  public async recordPaymentCapture(
    payment: PaymentEntity,
    context: RequestContext = {}
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }> {
    // 1. Ensure Merchant Settlement Receivable account exists
    const merchantReceivableAccount = await this.getOrCreateAccount({
      merchantId: payment.merchantId,
      code: 'MERCHANT_SETTLEMENT_RECEIVABLE',
      name: `Merchant Settlement Receivable (${payment.currency})`,
      type: 'ASSET',
      currency: payment.currency,
    });

    // 2. Ensure Platform Payment Clearing account exists
    const paymentClearingAccount = await this.getOrCreateAccount({
      merchantId: null, // Platform clearing account
      code: 'PAYMENT_CLEARING',
      name: `Platform Payment Clearing (${payment.currency})`,
      type: 'CLEARING',
      currency: payment.currency,
    });

    // 3. Post balanced capture transaction
    return await this.createLedgerTransaction(
      {
        referenceType: 'PAYMENT',
        referenceId: payment.id,
        transactionType: 'CAPTURE',
        currency: payment.currency,
        description: `Payment capture for payment ${payment.id}`,
        entries: [
          {
            accountId: merchantReceivableAccount.id,
            entryType: 'DEBIT',
            amountMinor: payment.amountMinor,
          },
          {
            accountId: paymentClearingAccount.id,
            entryType: 'CREDIT',
            amountMinor: payment.amountMinor,
          },
        ],
        actorId: context.actorId,
        correlationId: context.correlationId,
      },
      context
    );
  }

  /**
   * Connects Payment Refund to the Double-Entry Ledger
   * Creates a balanced compensating entry: Debits Payment Clearing and Credits Merchant Receivable
   */
  public async recordPaymentRefund(
    refund: RefundEntity,
    context: RequestContext = {}
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }> {
    // 1. Ensure Platform Payment Clearing account exists
    const paymentClearingAccount = await this.getOrCreateAccount({
      merchantId: null, // Platform clearing account
      code: 'PAYMENT_CLEARING',
      name: `Platform Payment Clearing (${refund.currency})`,
      type: 'CLEARING',
      currency: refund.currency,
    });

    // 2. Ensure Merchant Settlement Receivable account exists
    const merchantReceivableAccount = await this.getOrCreateAccount({
      merchantId: refund.merchantId,
      code: 'MERCHANT_SETTLEMENT_RECEIVABLE',
      name: `Merchant Settlement Receivable (${refund.currency})`,
      type: 'ASSET',
      currency: refund.currency,
    });

    // 3. Post balanced compensating refund transaction (referenceId: refund.id, transactionType: 'REFUND')
    return await this.createLedgerTransaction(
      {
        referenceType: 'REFUND',
        referenceId: refund.id,
        transactionType: 'REFUND',
        currency: refund.currency,
        description: `Refund ${refund.id} for payment ${refund.paymentId}${refund.reason ? ': ' + refund.reason : ''}`,
        entries: [
          {
            accountId: paymentClearingAccount.id,
            entryType: 'DEBIT',
            amountMinor: refund.amountMinor,
          },
          {
            accountId: merchantReceivableAccount.id,
            entryType: 'CREDIT',
            amountMinor: refund.amountMinor,
          },
        ],
        actorId: context.actorId,
        correlationId: context.correlationId,
      },
      context
    );
  }

  /**
   * Connects Settlement Execution to the Double-Entry Ledger (Milestone 10)
   * Debits Platform Settlement Clearing and Credits Merchant Settlement Receivable for the net settlement amount.
   */
  public async recordSettlement(
    batch: {
      id: string;
      batchReference: string;
      merchantId: string;
      netAmountMinor: bigint | number;
      currency: string;
      description?: string;
    },
    context: RequestContext = {}
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null> {
    const netAmount =
      typeof batch.netAmountMinor === 'bigint'
        ? batch.netAmountMinor
        : BigInt(batch.netAmountMinor);

    if (netAmount <= 0n) {
      logger.info(
        `Settlement batch ${batch.id} net amount is ${netAmount}. Skipping ledger transaction creation.`,
        { correlationId: context.correlationId, batchId: batch.id }
      );
      return null;
    }

    // 1. Ensure Platform Settlement Clearing account exists
    const settlementClearingAccount = await this.getOrCreateAccount({
      merchantId: null, // Platform clearing
      code: 'SETTLEMENT_CLEARING',
      name: `Platform Settlement Clearing (${batch.currency})`,
      type: 'CLEARING',
      currency: batch.currency,
    });

    // 2. Ensure Merchant Settlement Receivable account exists
    const merchantReceivableAccount = await this.getOrCreateAccount({
      merchantId: batch.merchantId,
      code: 'MERCHANT_SETTLEMENT_RECEIVABLE',
      name: `Merchant Settlement Receivable (${batch.currency})`,
      type: 'ASSET',
      currency: batch.currency,
    });

    // 3. Post balanced settlement payout transaction
    return await this.createLedgerTransaction(
      {
        referenceType: 'SETTLEMENT',
        referenceId: batch.id,
        transactionType: 'SETTLEMENT',
        currency: batch.currency,
        description:
          batch.description ||
          `Settlement payout for batch ${batch.batchReference || batch.id} (${batch.merchantId})`,
        entries: [
          {
            accountId: settlementClearingAccount.id,
            entryType: 'DEBIT',
            amountMinor: netAmount,
          },
          {
            accountId: merchantReceivableAccount.id,
            entryType: 'CREDIT',
            amountMinor: netAmount,
          },
        ],
        actorId: context.actorId,
        correlationId: context.correlationId,
      },
      context
    );
  }

  public async getOrCreateAccount(params: {
    merchantId?: string | null;
    code: string;
    name: string;
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' | 'CLEARING';
    currency: string;
  }): Promise<LedgerAccountEntity> {
    const existing = await this.repository.findAccountByCode(
      params.merchantId || null,
      params.code,
      params.currency
    );
    if (existing) {
      return existing;
    }

    const newAccount: LedgerAccountEntity = {
      id: crypto.randomUUID(),
      merchantId: params.merchantId || null,
      code: params.code,
      name: params.name,
      type: params.type,
      currency: params.currency,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return await this.repository.saveAccount(newAccount);
  }

  public async getAccountById(accountId: string): Promise<LedgerAccountEntity> {
    const account = await this.repository.findAccountById(accountId);
    if (!account) {
      throw new NotFoundError('LedgerAccount', accountId);
    }
    return account;
  }

  public async getAccountWithBalance(accountId: string): Promise<AccountBalanceSummary> {
    const cacheKey = RedisKeys.accountCache(accountId);
    const cached = await this.cacheService.get<{
      accountId: string;
      accountCode: string;
      accountName: string;
      accountType: AccountBalanceSummary['accountType'];
      currency: string;
      totalDebitsMinor: string;
      totalCreditsMinor: string;
      netBalanceMinor: string;
      entryCount: number;
    }>(cacheKey);

    if (cached) {
      return {
        ...cached,
        totalDebitsMinor: BigInt(cached.totalDebitsMinor),
        totalCreditsMinor: BigInt(cached.totalCreditsMinor),
        netBalanceMinor: BigInt(cached.netBalanceMinor),
      };
    }

    const summary = await this.repository.calculateAccountBalance(accountId);
    if (!summary) {
      throw new NotFoundError('LedgerAccount', accountId);
    }

    await this.cacheService.set(cacheKey, summary, config.CACHE_TTL_ACCOUNT_SECS);
    return summary;
  }

  public async listAccounts(merchantId?: string): Promise<LedgerAccountEntity[]> {
    return await this.repository.listAccounts(merchantId);
  }

  public async listAccountEntries(
    accountId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{ entries: LedgerEntryEntity[]; total: number; page: number; limit: number; totalPages: number }> {
    await this.getAccountById(accountId); // Verify account exists
    const { entries, total } = await this.repository.findEntriesByAccount(accountId, page, limit);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      entries,
      total,
      page,
      limit,
      totalPages,
    };
  }

  public async getTransactionById(
    id: string
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }> {
    const tx = await this.repository.findTransactionById(id);
    if (!tx) {
      throw new NotFoundError('LedgerTransaction', id);
    }
    return tx;
  }

  public async listTransactions(
    filter: LedgerTransactionFilter
  ): Promise<{
    transactions: (LedgerTransactionEntity & { entries: LedgerEntryEntity[] })[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const { transactions, total } = await this.repository.findTransactions(filter);
    const totalPages = Math.ceil(total / filter.limit) || 1;

    return {
      transactions,
      total,
      page: filter.page,
      limit: filter.limit,
      totalPages,
    };
  }

  public async verifyLedgerIntegrity(): Promise<LedgerIntegrityReport> {
    return await this.repository.checkLedgerIntegrity();
  }
}
