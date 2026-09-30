import {
  IReconciliationRepository,
  PrismaReconciliationRepository,
  InMemoryReconciliationRepository,
} from './reconciliation.repository.js';
import { ReconciliationMatcher } from './reconciliation-matcher.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationConsumer } from './reconciliation-consumer.service.js';
import { createReconciliationRouter } from './reconciliation.router.js';
import { checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../../common/logger.js';
import { getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import type { Router } from 'express';

export interface ReconciliationContainer {
  repository: IReconciliationRepository;
  matcher: ReconciliationMatcher;
  service: ReconciliationService;
  controller: ReconciliationController;
  consumer: ReconciliationConsumer;
  router: Router;
}

let activeContainer: ReconciliationContainer | null = null;

export async function createReconciliationContainer(options?: {
  repository?: IReconciliationRepository;
}): Promise<ReconciliationContainer> {
  let repository = options?.repository;

  if (!repository) {
    if (process.env.NODE_ENV === 'test') {
      repository = new InMemoryReconciliationRepository();
    } else {
      const dbHealth = await checkDatabaseHealth();
      if (dbHealth.connected) {
        logger.info('Using PrismaReconciliationRepository (PostgreSQL connected)');
        repository = new PrismaReconciliationRepository();
      } else {
        logger.info('PostgreSQL not connected; initializing In-Memory Reconciliation Repository');
        repository = new InMemoryReconciliationRepository();
      }
    }
  }

  const kafkaProducer = getKafkaProducerService();
  const matcher = new ReconciliationMatcher();
  const service = new ReconciliationService(repository, matcher, kafkaProducer);
  const controller = new ReconciliationController(service);
  const consumer = new ReconciliationConsumer({ reconciliationService: service });
  const router = createReconciliationRouter(controller);

  return {
    repository,
    matcher,
    service,
    controller,
    consumer,
    router,
  };
}

export async function getReconciliationContainer(): Promise<ReconciliationContainer> {
  if (!activeContainer) {
    activeContainer = await createReconciliationContainer();
  }
  return activeContainer;
}

export function setReconciliationContainer(container: ReconciliationContainer): void {
  activeContainer = container;
}

export function resetReconciliationContainer(): void {
  activeContainer = null;
}
