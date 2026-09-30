import { getOutboxPublisher } from '../src/infra/outbox/outbox-publisher.js';
import { logger } from '../src/common/logger.js';

async function main() {
  logger.info('Starting standalone Outbox Publisher Worker daemon...');
  const publisher = getOutboxPublisher();
  publisher.start();

  const shutdown = () => {
    logger.info('Shutting down Outbox Publisher Worker...');
    publisher.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Failed to run outbox publisher worker', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
