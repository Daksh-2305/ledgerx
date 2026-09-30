import type {
  InternalRecordSummary,
  ExternalTransactionEntity,
  ReconciliationRecordEntity,
} from './reconciliation.types.js';

export interface MatcherOutput {
  records: Omit<ReconciliationRecordEntity, 'id' | 'createdAt' | 'updatedAt'>[];
  matchedCount: number;
  mismatchCount: number;
  missingInternalCount: number;
  missingExternalCount: number;
  duplicateCount: number;
  totalInternal: number;
  totalExternal: number;
}

/**
 * Deterministic status normalization and compatibility check.
 */
export function areStatusesCompatible(internalStatus: string, externalStatus: string): boolean {
  const normInt = internalStatus.toUpperCase().trim();
  const normExt = externalStatus.toUpperCase().trim();

  if (normInt === normExt) {
    return true;
  }

  const successStatuses = new Set(['CAPTURED', 'SETTLED', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED']);
  if (successStatuses.has(normInt) && successStatuses.has(normExt)) {
    return true;
  }

  const failedStatuses = new Set(['FAILED', 'DECLINED', 'CANCELLED']);
  if (failedStatuses.has(normInt) && failedStatuses.has(normExt)) {
    return true;
  }

  return false;
}

/**
 * Deterministic Reconciliation Matcher.
 * Matches internal ledger records against external provider records with O(N + M) complexity.
 * Fuzzy matching is strictly forbidden.
 */
export class ReconciliationMatcher {
  /**
   * Reconcile internal and external records deterministically.
   */
  public match(
    runId: string,
    internalRecords: InternalRecordSummary[],
    externalRecords: ExternalTransactionEntity[]
  ): MatcherOutput {
    const results: Omit<ReconciliationRecordEntity, 'id' | 'createdAt' | 'updatedAt'>[] = [];

    // 1. Index internal records by all possible deterministic reference keys
    // Key -> InternalRecordSummary[]
    const internalByKey = new Map<string, InternalRecordSummary[]>();

    for (const record of internalRecords) {
      const keysToRegister = new Set<string>();
      if (record.id) keysToRegister.add(record.id.toLowerCase());
      if (record.reference) keysToRegister.add(record.reference.toLowerCase());
      if (record.idempotencyKey) keysToRegister.add(record.idempotencyKey.toLowerCase());

      for (const key of keysToRegister) {
        const list = internalByKey.get(key) || [];
        list.push(record);
        internalByKey.set(key, list);
      }
    }

    // 2. Index external records by externalTransactionId to identify duplicates
    const externalByTxId = new Map<string, ExternalTransactionEntity[]>();
    for (const ext of externalRecords) {
      const txIdKey = ext.externalTransactionId.toLowerCase();
      const list = externalByTxId.get(txIdKey) || [];
      list.push(ext);
      externalByTxId.set(txIdKey, list);
    }

    // Track matched internal record IDs so we can find MISSING_EXTERNAL later
    const matchedInternalIds = new Set<string>();
    // Track external transaction IDs processed to detect duplicates
    const seenExternalTxIds = new Set<string>();

    let matchedCount = 0;
    let mismatchCount = 0;
    let missingInternalCount = 0;
    let missingExternalCount = 0;
    let duplicateCount = 0;

    // 3. Process each external record
    for (const ext of externalRecords) {
      const txIdKey = ext.externalTransactionId.toLowerCase();

      // Check for DUPLICATE_EXTERNAL
      if (seenExternalTxIds.has(txIdKey)) {
        duplicateCount++;
        results.push({
          runId,
          internalReference: null,
          externalReference: ext.externalReference,
          internalTransactionId: null,
          externalTransactionId: ext.externalTransactionId,
          externalDbRecordId: ext.id,
          result: 'DUPLICATE_EXTERNAL',
          differenceMinor: ext.amountMinor,
          reason: `Duplicate external transaction ID: ${ext.externalTransactionId}`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: null,
          externalAmountMinor: ext.amountMinor,
        });
        continue;
      }
      seenExternalTxIds.add(txIdKey);

      // Deterministic Match Hierarchy:
      // Priority 1: ext.paymentReference
      // Priority 2: ext.externalReference
      let candidateMatches: InternalRecordSummary[] | undefined;

      if (ext.paymentReference) {
        candidateMatches = internalByKey.get(ext.paymentReference.toLowerCase());
      }

      if ((!candidateMatches || candidateMatches.length === 0) && ext.externalReference) {
        candidateMatches = internalByKey.get(ext.externalReference.toLowerCase());
      }

      // If no internal record matches reference -> MISSING_INTERNAL
      if (!candidateMatches || candidateMatches.length === 0) {
        missingInternalCount++;
        results.push({
          runId,
          internalReference: null,
          externalReference: ext.externalReference,
          internalTransactionId: null,
          externalTransactionId: ext.externalTransactionId,
          externalDbRecordId: ext.id,
          result: 'MISSING_INTERNAL',
          differenceMinor: ext.amountMinor,
          reason: `No corresponding internal transaction found for external reference: ${ext.externalReference}`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: null,
          externalAmountMinor: ext.amountMinor,
        });
        continue;
      }

      const firstCandidate = candidateMatches[0];
      if (!firstCandidate) continue;

      // Check if internal has duplicates
      if (candidateMatches.length > 1) {
        duplicateCount++;
        results.push({
          runId,
          internalReference: firstCandidate.reference,
          externalReference: ext.externalReference,
          internalTransactionId: firstCandidate.id,
          externalTransactionId: ext.externalTransactionId,
          externalDbRecordId: ext.id,
          result: 'DUPLICATE_INTERNAL',
          differenceMinor: 0n,
          reason: `Multiple internal transactions share reference ${firstCandidate.reference} (${candidateMatches.length} records found)`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: firstCandidate.amountMinor,
          externalAmountMinor: ext.amountMinor,
        });
        matchedInternalIds.add(firstCandidate.id);
        continue;
      }

      const internalRecord = firstCandidate;
      matchedInternalIds.add(internalRecord.id);

      // Compare Currency
      if (internalRecord.currency.toUpperCase() !== ext.currency.toUpperCase()) {
        mismatchCount++;
        results.push({
          runId,
          internalReference: internalRecord.reference,
          externalReference: ext.externalReference,
          internalTransactionId: internalRecord.id,
          externalTransactionId: ext.externalTransactionId,
          externalDbRecordId: ext.id,
          result: 'CURRENCY_MISMATCH',
          differenceMinor: 0n,
          reason: `Currency mismatch: internal ${internalRecord.currency.toUpperCase()} vs external ${ext.currency.toUpperCase()}`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: internalRecord.amountMinor,
          externalAmountMinor: ext.amountMinor,
        });
        continue;
      }

      // Compare Amount
      const diffMinor = ext.amountMinor - internalRecord.amountMinor;
      if (diffMinor !== 0n) {
        mismatchCount++;
        results.push({
          runId,
          internalReference: internalRecord.reference,
          externalReference: ext.externalReference,
          internalTransactionId: internalRecord.id,
          externalTransactionId: ext.externalTransactionId,
          externalDbRecordId: ext.id,
          result: 'AMOUNT_MISMATCH',
          differenceMinor: diffMinor,
          reason: `Amount mismatch: internal ${internalRecord.amountMinor.toString()} vs external ${ext.amountMinor.toString()} (diff: ${diffMinor.toString()})`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: internalRecord.amountMinor,
          externalAmountMinor: ext.amountMinor,
        });
        continue;
      }

      // Compare Status
      if (!areStatusesCompatible(internalRecord.status, ext.status)) {
        mismatchCount++;
        results.push({
          runId,
          internalReference: internalRecord.reference,
          externalReference: ext.externalReference,
          internalTransactionId: internalRecord.id,
          externalTransactionId: ext.externalTransactionId,
          externalDbRecordId: ext.id,
          result: 'STATUS_MISMATCH',
          differenceMinor: 0n,
          reason: `Status mismatch: internal ${internalRecord.status.toUpperCase()} vs external ${ext.status.toUpperCase()}`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: internalRecord.amountMinor,
          externalAmountMinor: ext.amountMinor,
        });
        continue;
      }

      // All fields match deterministically
      matchedCount++;
      results.push({
        runId,
        internalReference: internalRecord.reference,
        externalReference: ext.externalReference,
        internalTransactionId: internalRecord.id,
        externalTransactionId: ext.externalTransactionId,
        externalDbRecordId: ext.id,
        result: 'MATCHED',
        differenceMinor: 0n,
        reason: 'Deterministic exact match',
        status: 'RESOLVED',
        resolvedBy: 'SYSTEM_RECONCILER',
        resolvedAt: new Date(),
        resolutionNotes: 'Matched automatically',
        internalAmountMinor: internalRecord.amountMinor,
        externalAmountMinor: ext.amountMinor,
      });
    }

    // 4. Find MISSING_EXTERNAL: Internal records that were never matched by any external record
    for (const internalRecord of internalRecords) {
      if (!matchedInternalIds.has(internalRecord.id)) {
        missingExternalCount++;
        results.push({
          runId,
          internalReference: internalRecord.reference,
          externalReference: null,
          internalTransactionId: internalRecord.id,
          externalTransactionId: null,
          externalDbRecordId: null,
          result: 'MISSING_EXTERNAL',
          differenceMinor: -internalRecord.amountMinor,
          reason: `No corresponding external provider transaction found for internal reference: ${internalRecord.reference}`,
          status: 'OPEN',
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: null,
          internalAmountMinor: internalRecord.amountMinor,
          externalAmountMinor: null,
        });
      }
    }

    return {
      records: results,
      matchedCount,
      mismatchCount,
      missingInternalCount,
      missingExternalCount,
      duplicateCount,
      totalInternal: internalRecords.length,
      totalExternal: externalRecords.length,
    };
  }
}

export const reconciliationMatcher = new ReconciliationMatcher();
