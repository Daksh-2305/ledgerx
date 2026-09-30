import crypto from 'node:crypto';

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecordEntity {
  id: string;
  key: string;
  merchantId?: string | null;
  requestMethod: string;
  requestPath: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus?: number | null;
  responseBody?: unknown | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Computes deterministic SHA-256 hash for HTTP request method, path, and sorted body keys.
 */
export function computeRequestHash(method: string, path: string, body: unknown): string {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase().replace(/\/+$/, '');
  const canonicalBody = canonicalJsonStringify(body || {});

  const payload = `${normalizedMethod}:${normalizedPath}:${canonicalBody}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Deterministically stringifies JSON by sorting keys recursively to ensure payload equivalence.
 */
function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);

  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJsonStringify).join(',')}]`;
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = sortedKeys.map(
    (key) => `"${key}":${canonicalJsonStringify((obj as Record<string, unknown>)[key])}`
  );
  return `{${parts.join(',')}}`;
}
