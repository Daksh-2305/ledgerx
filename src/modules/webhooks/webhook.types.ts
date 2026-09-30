import crypto from 'node:crypto';

export type WebhookEventStatus =
  | 'RECEIVED'
  | 'VALIDATED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'RETRY_PENDING'
  | 'FAILED'
  | 'DEAD_LETTERED';

export type DeadLetterStatus = 'PENDING' | 'REPLAYED' | 'RESOLVED' | 'IGNORED';

export interface WebhookEventEntity {
  id: string;
  eventId: string;
  provider: string;
  eventType: string;
  externalReference: string | null;
  merchantId: string | null;
  signature: string | null;
  payload: Record<string, unknown>;
  status: WebhookEventStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeadLetterEventEntity {
  id: string;
  eventId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  reason: string;
  attempts: number;
  status: DeadLetterStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
}

export interface MockpayPayloadData {
  payment_id: string;
  amount_minor?: number | bigint;
  currency?: string;
  external_reference?: string;
  merchant_id?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface MockpayWebhookPayload {
  event_id: string;
  event_type: string;
  created_at?: string;
  data: MockpayPayloadData;
}

export interface WebhookFilter {
  provider?: string;
  eventType?: string;
  status?: WebhookEventStatus;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface DeadLetterFilter {
  status?: DeadLetterStatus;
  eventType?: string;
  page?: number;
  limit?: number;
}

export interface IngestWebhookResponse {
  received: boolean;
  duplicate?: boolean;
  id?: string;
  event_id: string;
  provider: string;
  status: WebhookEventStatus | 'ACCEPTED';
}

/**
 * Computes timing-safe HMAC-SHA256 signature for webhook payloads.
 */
export function generateHmacSignature(secret: string, rawBody: string | Buffer): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Timing-safe HMAC verification preventing timing attacks.
 * Accepts signature formatted as 'sha256=<hex>' or raw '<hex>'.
 */
export function verifyHmacSignature(
  secret: string,
  rawBody: string | Buffer,
  providedSignature: string | undefined | null
): boolean {
  if (!providedSignature || typeof providedSignature !== 'string') {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedHex = hmac.digest('hex');
  const expectedWithPrefix = `sha256=${expectedHex}`;

  // Normalize provided signature
  const cleanProvided = providedSignature.trim();

  // If signature has sha256= prefix, compare against prefixed
  if (cleanProvided.startsWith('sha256=')) {
    const expectedBuf = Buffer.from(expectedWithPrefix, 'utf-8');
    const providedBuf = Buffer.from(cleanProvided, 'utf-8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  // Otherwise compare hex directly
  const expectedHexBuf = Buffer.from(expectedHex, 'utf-8');
  const providedHexBuf = Buffer.from(cleanProvided, 'utf-8');
  if (expectedHexBuf.length !== providedHexBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedHexBuf, providedHexBuf);
}
