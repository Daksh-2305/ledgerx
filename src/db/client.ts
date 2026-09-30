import { PrismaClient } from '@prisma/client';
import { logger } from '../common/logger.js';

let prismaInstance: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    prismaInstance.$on('error' as never, (e: unknown) => {
      logger.error('Prisma client error', { error: { name: 'PrismaError', message: String(e) } });
    });

    prismaInstance.$on('warn' as never, (e: unknown) => {
      logger.warn('Prisma client warning', { details: e });
    });
  }
  return prismaInstance;
}

let cachedHealthResult: { result: { connected: boolean; latencyMs: number; error?: string }; expiresAt: number } | null = null;

export async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  latencyMs: number;
  error?: string;
}> {
  const now = Date.now();
  if (cachedHealthResult && now < cachedHealthResult.expiresAt) {
    return cachedHealthResult.result;
  }

  const start = Date.now();
  try {
    const client = getPrismaClient();

    // Fast 1000ms timeout race to avoid blocking application if DB host is unreachable
    const queryPromise = client.$queryRaw`SELECT 1`;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Database probe timed out after 1000ms')), 1000)
    );

    await Promise.race([queryPromise, timeoutPromise]);

    const result = {
      connected: true,
      latencyMs: Date.now() - start,
    };
    cachedHealthResult = { result, expiresAt: now + 5000 };
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const result = {
      connected: false,
      latencyMs: Date.now() - start,
      error: message,
    };
    cachedHealthResult = { result, expiresAt: now + 5000 };
    return result;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}
