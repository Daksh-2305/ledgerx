import { IWebhookRepository, PrismaWebhookRepository, InMemoryWebhookRepository } from './webhook.repository.js';
import { IDeadLetterRepository, PrismaDeadLetterRepository, InMemoryDeadLetterRepository } from './dead-letter.repository.js';
import { WebhookService } from './webhook.service.js';
import { WebhookController } from './webhook.controller.js';
import { WebhookProcessorConsumer } from './webhook-consumer.service.js';
import { getPaymentContainer } from '../payments/payment.container.js';
import { checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../../common/logger.js';
import { getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';

export interface WebhookContainer {
  webhookRepo: IWebhookRepository;
  deadLetterRepo: IDeadLetterRepository;
  service: WebhookService;
  controller: WebhookController;
  consumer: WebhookProcessorConsumer;
}

let activeContainer: WebhookContainer | null = null;

export async function createWebhookContainer(options?: {
  webhookRepo?: IWebhookRepository;
  deadLetterRepo?: IDeadLetterRepository;
}): Promise<WebhookContainer> {
  let webhookRepo = options?.webhookRepo;
  let deadLetterRepo = options?.deadLetterRepo;

  if (!webhookRepo || !deadLetterRepo) {
    if (process.env.NODE_ENV === 'test') {
      webhookRepo = webhookRepo ?? new InMemoryWebhookRepository();
      deadLetterRepo = deadLetterRepo ?? new InMemoryDeadLetterRepository();
    } else {
      const dbHealth = await checkDatabaseHealth();
      if (dbHealth.connected) {
        logger.info('Using Prisma Webhook & DeadLetter Repositories (PostgreSQL connected)');
        webhookRepo = webhookRepo ?? new PrismaWebhookRepository();
        deadLetterRepo = deadLetterRepo ?? new PrismaDeadLetterRepository();
      } else {
        logger.info('PostgreSQL not connected; initializing In-Memory Webhook & DeadLetter Repositories');
        webhookRepo = webhookRepo ?? new InMemoryWebhookRepository();
        deadLetterRepo = deadLetterRepo ?? new InMemoryDeadLetterRepository();
      }
    }
  }

  const kafkaProducer = getKafkaProducerService();
  const service = new WebhookService(webhookRepo, deadLetterRepo, kafkaProducer);
  const controller = new WebhookController(service);

  const paymentContainer = await getPaymentContainer();
  const consumer = new WebhookProcessorConsumer({
    webhookRepo,
    deadLetterRepo,
    paymentService: paymentContainer.service,
    kafkaProducer,
  });

  return {
    webhookRepo,
    deadLetterRepo,
    service,
    controller,
    consumer,
  };
}

export async function getWebhookContainer(): Promise<WebhookContainer> {
  if (!activeContainer) {
    activeContainer = await createWebhookContainer();
  }
  return activeContainer;
}

export function setWebhookContainer(container: WebhookContainer): void {
  activeContainer = container;
}

export function resetWebhookContainer(): void {
  activeContainer = null;
}
