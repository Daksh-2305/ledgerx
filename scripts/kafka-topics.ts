import { getKafkaClient } from '../src/infra/kafka/kafka.client.js';
import { KafkaTopics } from '../src/infra/kafka/event-envelope.js';
import { logger } from '../src/common/logger.js';

async function main() {
  logger.info('Initializing Kafka topic provisioning tool...');
  const client = await getKafkaClient();
  const admin = client.admin();

  try {
    await admin.connect();
    const existingTopics = await admin.listTopics();
    logger.info(`Existing Kafka topics: ${existingTopics.join(', ') || 'none'}`);

    const topicsToCreate = [
      { topic: KafkaTopics.PAYMENT_EVENTS, numPartitions: 3, replicationFactor: 1 },
      { topic: KafkaTopics.REFUND_EVENTS, numPartitions: 3, replicationFactor: 1 },
      { topic: KafkaTopics.SETTLEMENT_EVENTS, numPartitions: 3, replicationFactor: 1 },
      { topic: KafkaTopics.DOMAIN_EVENTS, numPartitions: 3, replicationFactor: 1 },
      { topic: KafkaTopics.RECONCILIATION_EVENTS, numPartitions: 3, replicationFactor: 1 },
    ];

    logger.info('Creating LedgerX Kafka topics...');
    await admin.createTopics(topicsToCreate);

    const updatedTopics = await admin.listTopics();
    logger.info(`Provisioned topics successfully: ${updatedTopics.join(', ')}`);
  } catch (err) {
    logger.error('Error provisioning Kafka topics', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    await admin.disconnect();
    process.exit(0);
  }
}

main();
