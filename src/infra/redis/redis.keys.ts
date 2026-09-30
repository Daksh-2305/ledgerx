/**
 * Standardized Redis Key Strategy for LedgerX (Milestone 5)
 *
 * Guarantees strict namespacing across caching, distributed locking,
 * rate limiting, and idempotency coordination.
 */

export const RedisKeyPrefix = {
  RATE: 'ledgerx:rate',
  CACHE_PAYMENT: 'ledgerx:cache:payment',
  CACHE_REFUNDS: 'ledgerx:cache:refunds',
  CACHE_ACCOUNT: 'ledgerx:cache:account',
  LOCK_PAYMENT: 'ledgerx:lock:payment',
  LOCK_REFUND: 'ledgerx:lock:refund',
  IDEMPOTENCY: 'ledgerx:idempotency',
} as const;

export const RedisKeys = {
  /**
   * Rate limiting key: e.g. ledgerx:rate:merchant:0000-0000 or ledgerx:rate:ip:127.0.0.1
   */
  rateLimit: (identifier: string): string => `${RedisKeyPrefix.RATE}:${identifier}`,

  /**
   * Payment cache key: e.g. ledgerx:cache:payment:uuid
   */
  paymentCache: (paymentId: string): string => `${RedisKeyPrefix.CACHE_PAYMENT}:${paymentId}`,

  /**
   * Refunds list cache key for a payment: e.g. ledgerx:cache:refunds:uuid
   */
  refundsCache: (paymentId: string): string => `${RedisKeyPrefix.CACHE_REFUNDS}:${paymentId}`,

  /**
   * Account cache key: e.g. ledgerx:cache:account:uuid
   */
  accountCache: (accountId: string): string => `${RedisKeyPrefix.CACHE_ACCOUNT}:${accountId}`,

  /**
   * Distributed lock key for a payment: e.g. ledgerx:lock:payment:uuid
   */
  paymentLock: (paymentId: string): string => `${RedisKeyPrefix.LOCK_PAYMENT}:${paymentId}`,

  /**
   * Distributed lock key for a refund operation: e.g. ledgerx:lock:refund:uuid
   */
  refundLock: (paymentId: string): string => `${RedisKeyPrefix.LOCK_REFUND}:${paymentId}`,

  /**
   * Fast-path idempotency tracking key: e.g. ledgerx:idempotency:merchantId:uniqueKey
   */
  idempotency: (merchantId: string | null, key: string): string =>
    `${RedisKeyPrefix.IDEMPOTENCY}:${merchantId || 'platform'}:${key}`,
};
