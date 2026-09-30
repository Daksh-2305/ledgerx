import { createServer } from './server.js';
import { config } from './config/index.js';
import { logger } from './common/logger.js';
import { disconnectDatabase } from './db/client.js';
import { getOutboxPublisher } from './infra/outbox/outbox-publisher.js';
import { getKafkaClient } from './infra/kafka/kafka.client.js';
import { setServerShuttingDown } from './modules/health/health.controller.js';
import { resetRedisClient } from './infra/redis/redis.client.js';

const app = createServer();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(`LedgerX platform started successfully`, {
    service: config.SERVICE_NAME,
    host: config.HOST,
    port: config.PORT,
    environment: config.NODE_ENV,
    url: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`,
  });

  // Start background outbox publisher
  getOutboxPublisher().start();
});

// Graceful shutdown handling
let isShuttingDown = false;

export async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  setServerShuttingDown(true);

  logger.info(`Received ${signal}. Initiating graceful shutdown...`, {
    service: config.SERVICE_NAME,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });

  // 1. Stop background outbox publisher
  getOutboxPublisher().stop();

  // 2. Stop accepting new requests & drain in-flight connections
  server.close(async (err) => {
    if (err) {
      logger.error('Error while closing HTTP server', {
        error: { name: err.name, message: err.message, stack: err.stack },
      });
      process.exit(1);
    }

    try {
      // 3. Disconnect Kafka consumers and producers
      const kafka = await getKafkaClient();
      await kafka.disconnect();

      // 4. Disconnect Redis client
      resetRedisClient();

      // 5. Disconnect PostgreSQL connection pool
      await disconnectDatabase();

      logger.info('All database, cache, and streaming connections closed cleanly. Server terminated safely.');
      process.exit(0);
    } catch (shutdownErr: unknown) {
      const msg = shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr);
      logger.error('Error during graceful service disconnection', {
        error: { name: 'ShutdownError', message: msg },
      });
      process.exit(1);
    }
  });

  // Force shutdown after timeout if pending connections hang
  setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing process termination.');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

