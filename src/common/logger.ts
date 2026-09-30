import { config } from '../config/index.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogPayload {
  message: string;
  requestId?: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  service?: string;
  event?: string;
  status?: string;
  durationMs?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const SENSITIVE_KEY_REGEX = /(password|secret|apikey|api_key|token|authorization|bearer|cookie|creditcard|cardnumber|cvv|pan)/i;

export function redactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }
  if (typeof data === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted;
  }
  return data;
}

class Logger {
  private serviceName: string;
  private currentLevelValue: number;

  constructor(serviceName: string, level: LogLevel) {
    this.serviceName = serviceName;
    this.currentLevelValue = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.currentLevelValue;
  }

  private format(level: LogLevel, payload: StructuredLogPayload): void {
    if (!this.shouldLog(level)) return;

    const sanitizedPayload = redactSensitiveData(payload) as StructuredLogPayload;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: sanitizedPayload.service || this.serviceName,
      message: sanitizedPayload.message,
      ...(sanitizedPayload.correlationId && { correlation_id: sanitizedPayload.correlationId }),
      ...(sanitizedPayload.requestId && { request_id: sanitizedPayload.requestId }),
      ...(sanitizedPayload.traceId && { trace_id: sanitizedPayload.traceId }),
      ...(sanitizedPayload.spanId && { span_id: sanitizedPayload.spanId }),
      ...(sanitizedPayload.event && { event: sanitizedPayload.event }),
      ...(sanitizedPayload.status && { status: sanitizedPayload.status }),
      ...(sanitizedPayload.durationMs !== undefined && { duration_ms: sanitizedPayload.durationMs }),
      ...(sanitizedPayload.error && { error: sanitizedPayload.error }),
      ...Object.fromEntries(
        Object.entries(sanitizedPayload).filter(
          ([key]) =>
            ![
              'message',
              'correlationId',
              'requestId',
              'traceId',
              'spanId',
              'service',
              'event',
              'status',
              'durationMs',
              'error',
            ].includes(key)
        )
      ),
    };

    if (config.NODE_ENV === 'production') {
      process.stdout.write(JSON.stringify(logEntry) + '\n');
    } else {
      const color =
        level === 'error'
          ? '\x1b[31m'
          : level === 'warn'
            ? '\x1b[33m'
            : level === 'info'
              ? '\x1b[36m'
              : '\x1b[90m';
      const reset = '\x1b[0m';
      const meta = [
        logEntry.correlation_id ? `[corr:${logEntry.correlation_id.slice(0, 8)}]` : '',
        logEntry.event ? `[${logEntry.event}]` : '',
        logEntry.duration_ms !== undefined ? `(${logEntry.duration_ms}ms)` : '',
      ]
        .filter(Boolean)
        .join(' ');

      // eslint-disable-next-line no-console
      console.log(
        `${color}${logEntry.timestamp} [${logEntry.level}] [${logEntry.service}]${reset} ${meta} ${logEntry.message}`
      );
      if (logEntry.error) {
        // eslint-disable-next-line no-console
        console.error(color, logEntry.error.stack || logEntry.error.message, reset);
      }
    }
  }

  info(message: string, meta: Omit<StructuredLogPayload, 'message'> = {}): void {
    this.format('info', { message, ...meta });
  }

  warn(message: string, meta: Omit<StructuredLogPayload, 'message'> = {}): void {
    this.format('warn', { message, ...meta });
  }

  error(message: string, meta: Omit<StructuredLogPayload, 'message'> = {}): void {
    this.format('error', { message, ...meta });
  }

  debug(message: string, meta: Omit<StructuredLogPayload, 'message'> = {}): void {
    this.format('debug', { message, ...meta });
  }
}

export const logger = new Logger(config.SERVICE_NAME, config.LOG_LEVEL);
