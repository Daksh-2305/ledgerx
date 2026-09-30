export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly errorCode: string;
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  public readonly statusCode = 404;
  public readonly errorCode = 'NOT_FOUND';

  constructor(resource: string, identifier?: string | number) {
    super(identifier ? `${resource} with identifier '${identifier}' not found` : `${resource} not found`);
  }
}

export class ValidationError extends AppError {
  public readonly statusCode = 400;
  public readonly errorCode = 'VALIDATION_ERROR';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class ConflictError extends AppError {
  public readonly statusCode = 409;
  public readonly errorCode = 'CONFLICT';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class IdempotencyConflictError extends AppError {
  public readonly statusCode = 409;
  public readonly errorCode = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string = 'Concurrent request with the same idempotency key is already in progress') {
    super(message);
  }
}

export class FinancialInvarianceError extends AppError {
  public readonly statusCode = 422;
  public readonly errorCode = 'FINANCIAL_INVARIANCE_VIOLATION';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class UnauthorizedError extends AppError {
  public readonly statusCode = 401;
  public readonly errorCode = 'UNAUTHORIZED';

  constructor(message: string = 'Authentication required') {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  public readonly statusCode = 403;
  public readonly errorCode = 'FORBIDDEN';

  constructor(message: string = 'Access forbidden') {
    super(message);
  }
}

export class InvalidStateTransitionError extends AppError {
  public readonly statusCode = 422;
  public readonly errorCode = 'INVALID_PAYMENT_STATE';

  constructor(fromState: string, toState: string, customMessage?: string) {
    super(
      customMessage || `Payment cannot transition from ${fromState} to ${toState}`,
      { fromState, toState }
    );
  }
}

export class IdempotencyKeyReusedError extends AppError {
  public readonly statusCode = 409;
  public readonly errorCode = 'IDEMPOTENCY_KEY_REUSED';

  constructor(message: string = 'Idempotency key has already been used with a different request payload') {
    super(message);
  }
}

export class RefundAmountExceededError extends AppError {
  public readonly statusCode = 422;
  public readonly errorCode = 'REFUND_AMOUNT_EXCEEDED';

  constructor(
    message: string = 'Refund amount exceeds the remaining refundable amount',
    details?: unknown
  ) {
    super(message, details);
  }
}

export class RateLimitExceededError extends AppError {
  public readonly statusCode = 429;
  public readonly errorCode = 'RATE_LIMIT_EXCEEDED';
  public readonly retryAfterSeconds: number;

  constructor(
    message: string = 'Too many requests. Rate limit exceeded.',
    retryAfterSeconds: number = 60
  ) {
    super(message, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}


