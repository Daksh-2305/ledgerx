import { Router } from 'express';
import {
  ISettlementRepository,
  PrismaSettlementRepository,
  InMemorySettlementRepository,
} from './settlement.repository.js';
import { SettlementService } from './settlement.service.js';
import { SettlementController } from './settlement.controller.js';
import { SettlementConsumer } from './settlement-consumer.service.js';
import { createSettlementRouter } from './settlement.router.js';
import { checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../../common/logger.js';
import { getLedgerContainer } from '../ledger/ledger.container.js';
import { getPaymentContainer } from '../payments/payment.container.js';
import { getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { getRedisCacheService } from '../../infra/redis/redis-cache.service.js';

export interface SettlementModuleContainer {
  repository: ISettlementRepository;
  service: SettlementService;
  controller: SettlementController;
  consumer: SettlementConsumer;
  router: Router;
}

let activeContainer: SettlementModuleContainer | null = null;

export async function createSettlementContainer(options?: {
  repository?: ISettlementRepository;
}): Promise<SettlementModuleContainer> {
  let repository = options?.repository;

  if (!repository) {
    if (process.env.NODE_ENV === 'test') {
      repository = new InMemorySettlementRepository();
    } else {
      const dbHealth = await checkDatabaseHealth();
      if (dbHealth.connected) {
        logger.info('Using PrismaSettlementRepository (PostgreSQL connected)');
        repository = new PrismaSettlementRepository();
      } else {
        logger.info('PostgreSQL not connected; initializing In-Memory Settlement Repository');
        const inMem = new InMemorySettlementRepository();
        inMem.setPaymentSupplier(async () => {
          try {
            const payCont = await getPaymentContainer();
            const res = await payCont.repository.findPayments({ page: 1, limit: 1000 });
            return res.payments;
          } catch {
            return [];
          }
        });
        repository = inMem;
      }
    }
  }

  const ledgerContainer = await getLedgerContainer();
  const kafkaProducer = getKafkaProducerService();
  const cacheService = getRedisCacheService();

  const service = new SettlementService(
    repository,
    ledgerContainer.service,
    kafkaProducer,
    cacheService
  );
  const controller = new SettlementController(service);
  const consumer = new SettlementConsumer({ settlementService: service });
  const router = createSettlementRouter(controller);

  return {
    repository,
    service,
    controller,
    consumer,
    router,
  };
}

export async function getSettlementContainer(): Promise<SettlementModuleContainer> {
  if (!activeContainer) {
    activeContainer = await createSettlementContainer();
  }
  return activeContainer;
}

export function setSettlementContainer(container: SettlementModuleContainer): void {
  activeContainer = container;
}

export function resetSettlementContainer(): void {
  activeContainer = null;
}

// Lazy router exported for Express mounting
export const settlementRouter: Router = Router();
settlementRouter.use(async (req, res, next) => {
  const container = await getSettlementContainer();
  return container.router(req, res, next);
});
