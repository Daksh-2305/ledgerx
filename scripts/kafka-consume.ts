import { getKafkaClient, KafkaMessageBatch } from '../src/infra/kafka/kafka.client.js';
import { KafkaTopics } from '../src/infra/kafka/event-envelope.js';
import { logger } from '../src/common/logger.js';

async function main() {
  const groupId = process.env.CONSUMER_GROUP || 'ledgerx-cli-consumer';
  const topic = process.env.TOPIC || KafkaTopics.PAYMENT_EVENTS;

  logger.info(`Starting interactive Kafka CLI consumer [group: ${groupId}, topic: ${topic}]...`);
  const client = await getKafkaClient();
  const consumer = client.consumer(groupId);

  await consumer.connect();
  await consumer.subscribe([topic], true);

  logger.info(`Listening for messages on topic: ${topic}... Press Ctrl+C to exit.`);

  await consumer.run(async (batch: KafkaMessageBatch) => {
    // eslint-disable-next-line no-console
    console.log('\n--- Incoming Kafka Message ---');
    // eslint-disable-next-line no-console
    console.log(`Topic:     ${batch.topic} (partition ${batch.partition})`);
    // eslint-disable-next-line no-console
    console.log(`Key:       ${batch.message.key}`);
    // eslint-disable-next-line no-console
    console.log(`Payload:   ${batch.message.value}`);
    // eslint-disable-next-line no-console
    console.log('-------------------------------\n');
  });

  process.on('SIGINT', async () => {
    logger.info('Shutting down Kafka CLI consumer...');
    await consumer.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Failed running Kafka consumer CLI', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
