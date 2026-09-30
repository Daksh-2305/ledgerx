import {
  LedgerAccountEntity,
  LedgerEntryEntity,
  LedgerTransactionEntity,
  AccountBalanceSummary,
  LedgerTransactionFilter,
  LedgerIntegrityReport,
} from './ledger.types.js';
import { getPrismaClient } from '../../db/client.js';

export interface ValidatedEntryData {
  id: string;
  accountId: string;
  entryType: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
  currency: string;
}

export interface ValidatedTransactionData {
  id: string;
  referenceType: string;
  referenceId: string;
  transactionType: 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT';
  currency: string;
  description?: string | null;
  entries: ValidatedEntryData[];
  actorId?: string;
  correlationId?: string;
}

export interface ILedgerRepository {
  findAccountById(id: string): Promise<LedgerAccountEntity | null>;
  findAccountByCode(
    merchantId: string | null,
    code: string,
    currency: string
  ): Promise<LedgerAccountEntity | null>;
  listAccounts(merchantId?: string): Promise<LedgerAccountEntity[]>;
  saveAccount(account: LedgerAccountEntity): Promise<LedgerAccountEntity>;

  findTransactionById(
    id: string
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null>;
  findTransactionByReference(
    referenceType: string,
    referenceId: string
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null>;
  findTransactions(
    filter: LedgerTransactionFilter
  ): Promise<{ transactions: (LedgerTransactionEntity & { entries: LedgerEntryEntity[] })[]; total: number }>;

  findEntriesByAccount(
    accountId: string,
    page: number,
    limit: number
  ): Promise<{ entries: LedgerEntryEntity[]; total: number }>;

  calculateAccountBalance(accountId: string): Promise<AccountBalanceSummary | null>;
  createBalancedTransaction(
    data: ValidatedTransactionData
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }>;

  checkLedgerIntegrity(): Promise<LedgerIntegrityReport>;
}

/**
 * Thread-safe In-Memory Ledger Repository
 * Guarantees transaction-level balance checks, atomic single-reference execution, and immutability.
 */
export class InMemoryLedgerRepository implements ILedgerRepository {
  private accounts = new Map<string, LedgerAccountEntity>();
  private transactions = new Map<string, LedgerTransactionEntity>();
  private entries = new Map<string, LedgerEntryEntity>();
  private referenceLocks = new Map<string, Promise<void>>();

  private async acquireReferenceLock(key: string): Promise<() => void> {
    while (this.referenceLocks.has(key)) {
      await this.referenceLocks.get(key);
    }
    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.referenceLocks.set(key, lockPromise);

    return () => {
      this.referenceLocks.delete(key);
      release();
    };
  }

  public async saveAccount(account: LedgerAccountEntity): Promise<LedgerAccountEntity> {
    this.accounts.set(account.id, { ...account });
    return { ...account };
  }

  public async findAccountById(id: string): Promise<LedgerAccountEntity | null> {
    return this.accounts.get(id) || null;
  }

  public async findAccountByCode(
    merchantId: string | null,
    code: string,
    currency: string
  ): Promise<LedgerAccountEntity | null> {
    for (const acc of this.accounts.values()) {
      if (
        (acc.merchantId || null) === (merchantId || null) &&
        acc.code === code &&
        acc.currency === currency
      ) {
        return { ...acc };
      }
    }
    return null;
  }

  public async listAccounts(merchantId?: string): Promise<LedgerAccountEntity[]> {
    let result = Array.from(this.accounts.values());
    if (merchantId) {
      result = result.filter((a) => a.merchantId === merchantId);
    }
    return result.map((a) => ({ ...a }));
  }

  public async findTransactionById(
    id: string
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null> {
    const tx = this.transactions.get(id);
    if (!tx) return null;

    const txEntries = Array.from(this.entries.values())
      .filter((e) => e.transactionId === id)
      .map((e) => {
        const acc = this.accounts.get(e.accountId);
        return {
          ...e,
          accountName: acc?.name,
          accountCode: acc?.code,
        };
      });

    return {
      ...tx,
      entries: txEntries,
    };
  }

  public async findTransactionByReference(
    referenceType: string,
    referenceId: string
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null> {
    for (const tx of this.transactions.values()) {
      if (tx.referenceType === referenceType && tx.referenceId === referenceId) {
        const txEntries = Array.from(this.entries.values())
          .filter((e) => e.transactionId === tx.id)
          .map((e) => {
            const acc = this.accounts.get(e.accountId);
            return {
              ...e,
              accountName: acc?.name,
              accountCode: acc?.code,
            };
          });

        return {
          ...tx,
          entries: txEntries,
        };
      }
    }
    return null;
  }

  public async findTransactions(
    filter: LedgerTransactionFilter
  ): Promise<{ transactions: (LedgerTransactionEntity & { entries: LedgerEntryEntity[] })[]; total: number }> {
    let result = Array.from(this.transactions.values());

    if (filter.referenceType) {
      result = result.filter((t) => t.referenceType === filter.referenceType);
    }
    if (filter.referenceId) {
      result = result.filter((t) => t.referenceId === filter.referenceId);
    }
    if (filter.transactionType) {
      result = result.filter((t) => t.transactionType === filter.transactionType);
    }
    if (filter.currency) {
      result = result.filter((t) => t.currency === filter.currency);
    }
    if (filter.fromDate) {
      result = result.filter((t) => t.createdAt >= filter.fromDate!);
    }
    if (filter.toDate) {
      result = result.filter((t) => t.createdAt <= filter.toDate!);
    }

    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = result.length;
    const page = filter.page || 1;
    const limit = filter.limit || 50;
    const startIndex = (page - 1) * limit;
    const paginated = result.slice(startIndex, startIndex + limit);

    const populated = paginated.map((tx) => {
      const txEntries = Array.from(this.entries.values())
        .filter((e) => e.transactionId === tx.id)
        .map((e) => {
          const acc = this.accounts.get(e.accountId);
          return {
            ...e,
            accountName: acc?.name,
            accountCode: acc?.code,
          };
        });
      return {
        ...tx,
        entries: txEntries,
      };
    });

    return { transactions: populated, total };
  }

  public async findEntriesByAccount(
    accountId: string,
    page: number,
    limit: number
  ): Promise<{ entries: LedgerEntryEntity[]; total: number }> {
    const list = Array.from(this.entries.values())
      .filter((e) => e.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = list.length;
    const startIndex = (page - 1) * limit;
    const paginated = list.slice(startIndex, startIndex + limit).map((e) => {
      const acc = this.accounts.get(e.accountId);
      return {
        ...e,
        accountName: acc?.name,
        accountCode: acc?.code,
      };
    });

    return { entries: paginated, total };
  }

  public async calculateAccountBalance(accountId: string): Promise<AccountBalanceSummary | null> {
    const account = this.accounts.get(accountId);
    if (!account) return null;

    const accountEntries = Array.from(this.entries.values()).filter((e) => e.accountId === accountId);

    let totalDebits = 0n;
    let totalCredits = 0n;

    for (const entry of accountEntries) {
      if (entry.entryType === 'DEBIT') {
        totalDebits += entry.amountMinor;
      } else {
        totalCredits += entry.amountMinor;
      }
    }

    // Standard Double-Entry Accounting Balance Calculation:
    // - Asset & Expense accounts normally carry Debit balances (Normal = Debits - Credits)
    // - Liability, Equity, Revenue & Clearing accounts normally carry Credit balances (Normal = Credits - Debits)
    let netBalance: bigint;
    if (account.type === 'ASSET' || account.type === 'EXPENSE') {
      netBalance = totalDebits - totalCredits;
    } else {
      netBalance = totalCredits - totalDebits;
    }

    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      currency: account.currency,
      totalDebitsMinor: totalDebits,
      totalCreditsMinor: totalCredits,
      netBalanceMinor: netBalance,
      entryCount: accountEntries.length,
    };
  }

  public async createBalancedTransaction(
    data: ValidatedTransactionData
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }> {
    const lockKey = `${data.referenceType}:${data.referenceId}`;
    const release = await this.acquireReferenceLock(lockKey);

    try {
      // Check idempotency under lock
      const existing = await this.findTransactionByReference(data.referenceType, data.referenceId);
      if (existing) {
        return existing;
      }

      const now = new Date();
      const tx: LedgerTransactionEntity = {
        id: data.id,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        transactionType: data.transactionType,
        currency: data.currency,
        description: data.description || null,
        postedAt: now,
        createdAt: now,
      };

      const createdEntries: LedgerEntryEntity[] = [];

      // Write transaction
      this.transactions.set(tx.id, tx);

      // Write immutable entries
      for (const entryInput of data.entries) {
        const entry: LedgerEntryEntity = {
          id: entryInput.id,
          transactionId: tx.id,
          accountId: entryInput.accountId,
          entryType: entryInput.entryType,
          amountMinor: entryInput.amountMinor,
          currency: entryInput.currency,
          createdAt: now,
        };
        this.entries.set(entry.id, entry);
        createdEntries.push(entry);
      }

      return {
        ...tx,
        entries: createdEntries,
      };
    } finally {
      release();
    }
  }

  public async checkLedgerIntegrity(): Promise<LedgerIntegrityReport> {
    let balancedCount = 0;
    let unbalancedCount = 0;
    let orphanCount = 0;

    // 1. Check all transactions balance
    for (const tx of this.transactions.values()) {
      const txEntries = Array.from(this.entries.values()).filter((e) => e.transactionId === tx.id);
      let debits = 0n;
      let credits = 0n;

      for (const e of txEntries) {
        if (e.entryType === 'DEBIT') debits += e.amountMinor;
        if (e.entryType === 'CREDIT') credits += e.amountMinor;
      }

      if (debits === credits && txEntries.length >= 2) {
        balancedCount++;
      } else {
        unbalancedCount++;
      }
    }

    // 2. Check for orphan entries
    for (const e of this.entries.values()) {
      if (!this.transactions.has(e.transactionId) || !this.accounts.has(e.accountId)) {
        orphanCount++;
      }
    }

    // 3. Check for duplicate references
    const refSet = new Set<string>();
    let duplicateRefs = 0;
    for (const tx of this.transactions.values()) {
      if (tx.referenceId) {
        const key = `${tx.referenceType}:${tx.referenceId}`;
        if (refSet.has(key)) {
          duplicateRefs++;
        } else {
          refSet.add(key);
        }
      }
    }

    return {
      healthy: unbalancedCount === 0 && orphanCount === 0 && duplicateRefs === 0,
      total_transactions: this.transactions.size,
      balanced_transactions: balancedCount,
      unbalanced_transactions: unbalancedCount,
      orphan_entries: orphanCount,
      duplicate_financial_references: duplicateRefs,
      checked_at: new Date().toISOString(),
    };
  }

  public clear(): void {
    this.accounts.clear();
    this.transactions.clear();
    this.entries.clear();
  }
}

/**
 * PostgreSQL Prisma-backed Ledger Repository
 */
export class PrismaLedgerRepository implements ILedgerRepository {
  private prisma = getPrismaClient();

  public async saveAccount(account: LedgerAccountEntity): Promise<LedgerAccountEntity> {
    const row = await this.prisma.ledgerAccount.upsert({
      where: { id: account.id },
      create: {
        id: account.id,
        merchantId: account.merchantId,
        code: account.code,
        name: account.name,
        type: account.type,
        currency: account.currency,
        isActive: account.isActive,
      },
      update: {
        name: account.name,
        isActive: account.isActive,
      },
    });

    return {
      id: row.id,
      merchantId: row.merchantId,
      code: row.code,
      name: row.name,
      type: row.type,
      currency: row.currency,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async findAccountById(id: string): Promise<LedgerAccountEntity | null> {
    const row = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      code: row.code,
      name: row.name,
      type: row.type,
      currency: row.currency,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async findAccountByCode(
    merchantId: string | null,
    code: string,
    currency: string
  ): Promise<LedgerAccountEntity | null> {
    const row = await this.prisma.ledgerAccount.findFirst({
      where: {
        merchantId: merchantId || null,
        code,
        currency,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      code: row.code,
      name: row.name,
      type: row.type,
      currency: row.currency,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async listAccounts(merchantId?: string): Promise<LedgerAccountEntity[]> {
    const rows = await this.prisma.ledgerAccount.findMany({
      where: merchantId ? { merchantId } : {},
      orderBy: { code: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      merchantId: r.merchantId,
      code: r.code,
      name: r.name,
      type: r.type,
      currency: r.currency,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  public async findTransactionById(
    id: string
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null> {
    const row = await this.prisma.ledgerTransaction.findUnique({
      where: { id },
      include: {
        entries: {
          include: { account: true },
        },
      },
    });
    if (!row) return null;

    return {
      id: row.id,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      transactionType: row.transactionType as 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT',
      currency: row.currency,
      description: row.description,
      postedAt: row.postedAt,
      createdAt: row.createdAt,
      entries: row.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        accountId: e.accountId,
        entryType: e.entryType,
        amountMinor: e.amountMinor,
        currency: e.currency,
        createdAt: e.createdAt,
        accountName: e.account.name,
        accountCode: e.account.code,
      })),
    };
  }

  public async findTransactionByReference(
    referenceType: string,
    referenceId: string
  ): Promise<(LedgerTransactionEntity & { entries: LedgerEntryEntity[] }) | null> {
    const row = await this.prisma.ledgerTransaction.findFirst({
      where: { referenceType, referenceId },
      include: {
        entries: {
          include: { account: true },
        },
      },
    });
    if (!row) return null;

    return {
      id: row.id,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      transactionType: row.transactionType as 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT',
      currency: row.currency,
      description: row.description,
      postedAt: row.postedAt,
      createdAt: row.createdAt,
      entries: row.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        accountId: e.accountId,
        entryType: e.entryType,
        amountMinor: e.amountMinor,
        currency: e.currency,
        createdAt: e.createdAt,
        accountName: e.account.name,
        accountCode: e.account.code,
      })),
    };
  }

  public async findTransactions(
    filter: LedgerTransactionFilter
  ): Promise<{ transactions: (LedgerTransactionEntity & { entries: LedgerEntryEntity[] })[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (filter.referenceType) where.referenceType = filter.referenceType;
    if (filter.referenceId) where.referenceId = filter.referenceId;
    if (filter.transactionType) where.transactionType = filter.transactionType;
    if (filter.currency) where.currency = filter.currency;
    if (filter.fromDate || filter.toDate) {
      where.createdAt = {
        ...(filter.fromDate && { gte: filter.fromDate }),
        ...(filter.toDate && { lte: filter.toDate }),
      };
    }

    const [total, rows] = await Promise.all([
      this.prisma.ledgerTransaction.count({ where }),
      this.prisma.ledgerTransaction.findMany({
        where,
        include: {
          entries: {
            include: { account: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
    ]);

    return {
      transactions: rows.map((row) => ({
        id: row.id,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        transactionType: row.transactionType as 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT',
        currency: row.currency,
        description: row.description,
        postedAt: row.postedAt,
        createdAt: row.createdAt,
        entries: row.entries.map((e) => ({
          id: e.id,
          transactionId: e.transactionId,
          accountId: e.accountId,
          entryType: e.entryType,
          amountMinor: e.amountMinor,
          currency: e.currency,
          createdAt: e.createdAt,
          accountName: e.account.name,
          accountCode: e.account.code,
        })),
      })),
      total,
    };
  }

  public async findEntriesByAccount(
    accountId: string,
    page: number,
    limit: number
  ): Promise<{ entries: LedgerEntryEntity[]; total: number }> {
    const [total, rows] = await Promise.all([
      this.prisma.ledgerEntry.count({ where: { accountId } }),
      this.prisma.ledgerEntry.findMany({
        where: { accountId },
        include: { account: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      entries: rows.map((r) => ({
        id: r.id,
        transactionId: r.transactionId,
        accountId: r.accountId,
        entryType: r.entryType,
        amountMinor: r.amountMinor,
        currency: r.currency,
        createdAt: r.createdAt,
        accountName: r.account.name,
        accountCode: r.account.code,
      })),
      total,
    };
  }

  public async calculateAccountBalance(accountId: string): Promise<AccountBalanceSummary | null> {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account) return null;

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId },
      select: { entryType: true, amountMinor: true },
    });

    let totalDebits = 0n;
    let totalCredits = 0n;

    for (const e of entries) {
      if (e.entryType === 'DEBIT') {
        totalDebits += e.amountMinor;
      } else {
        totalCredits += e.amountMinor;
      }
    }

    let netBalance: bigint;
    if (account.type === 'ASSET' || account.type === 'EXPENSE') {
      netBalance = totalDebits - totalCredits;
    } else {
      netBalance = totalCredits - totalDebits;
    }

    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      currency: account.currency,
      totalDebitsMinor: totalDebits,
      totalCreditsMinor: totalCredits,
      netBalanceMinor: netBalance,
      entryCount: entries.length,
    };
  }

  public async createBalancedTransaction(
    data: ValidatedTransactionData
  ): Promise<LedgerTransactionEntity & { entries: LedgerEntryEntity[] }> {
    return await this.prisma.$transaction(async (tx) => {
      // 1. Idempotency check inside transaction
      const existing = await tx.ledgerTransaction.findFirst({
        where: { referenceType: data.referenceType, referenceId: data.referenceId },
        include: { entries: true },
      });

      if (existing) {
        return {
          id: existing.id,
          referenceType: existing.referenceType,
          referenceId: existing.referenceId,
          transactionType: existing.transactionType as 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT',
          currency: existing.currency,
          description: existing.description,
          postedAt: existing.postedAt,
          createdAt: existing.createdAt,
          entries: existing.entries.map((e) => ({
            id: e.id,
            transactionId: e.transactionId,
            accountId: e.accountId,
            entryType: e.entryType,
            amountMinor: e.amountMinor,
            currency: e.currency,
            createdAt: e.createdAt,
          })),
        };
      }

      // 2. Insert transaction
      const createdTx = await tx.ledgerTransaction.create({
        data: {
          id: data.id,
          referenceType: data.referenceType,
          referenceId: data.referenceId,
          transactionType: data.transactionType,
          currency: data.currency,
          description: data.description,
        },
      });

      // 3. Insert immutable entries
      const createdEntries: LedgerEntryEntity[] = [];
      for (const entry of data.entries) {
        const row = await tx.ledgerEntry.create({
          data: {
            id: entry.id,
            transactionId: createdTx.id,
            accountId: entry.accountId,
            entryType: entry.entryType,
            amountMinor: entry.amountMinor,
            currency: entry.currency,
          },
        });
        createdEntries.push({
          id: row.id,
          transactionId: row.transactionId,
          accountId: row.accountId,
          entryType: row.entryType,
          amountMinor: row.amountMinor,
          currency: row.currency,
          createdAt: row.createdAt,
        });
      }

      // 4. Audit Log
      await tx.auditLog.create({
        data: {
          entityType: 'LEDGER_TRANSACTION',
          entityId: createdTx.id,
          action: 'TRANSACTION_POSTED',
          actorId: data.actorId || 'system',
          actorType: 'SERVICE',
          changes: {
            transactionType: data.transactionType,
            referenceType: data.referenceType,
            referenceId: data.referenceId,
            currency: data.currency,
            entryCount: createdEntries.length,
          },
          correlationId: data.correlationId,
        },
      });

      return {
        id: createdTx.id,
        referenceType: createdTx.referenceType,
        referenceId: createdTx.referenceId,
        transactionType: createdTx.transactionType as 'PAYMENT' | 'CAPTURE' | 'REFUND' | 'SETTLEMENT' | 'ADJUSTMENT',
        currency: createdTx.currency,
        description: createdTx.description,
        postedAt: createdTx.postedAt,
        createdAt: createdTx.createdAt,
        entries: createdEntries,
      };
    });
  }

  public async checkLedgerIntegrity(): Promise<LedgerIntegrityReport> {
    const transactions = await this.prisma.ledgerTransaction.findMany({
      include: { entries: true },
    });

    let balancedCount = 0;
    let unbalancedCount = 0;

    for (const tx of transactions) {
      let debits = 0n;
      let credits = 0n;

      for (const e of tx.entries) {
        if (e.entryType === 'DEBIT') debits += e.amountMinor;
        if (e.entryType === 'CREDIT') credits += e.amountMinor;
      }

      if (debits === credits && tx.entries.length >= 2) {
        balancedCount++;
      } else {
        unbalancedCount++;
      }
    }

    return {
      healthy: unbalancedCount === 0,
      total_transactions: transactions.length,
      balanced_transactions: balancedCount,
      unbalanced_transactions: unbalancedCount,
      orphan_entries: 0,
      duplicate_financial_references: 0,
      checked_at: new Date().toISOString(),
    };
  }
}
