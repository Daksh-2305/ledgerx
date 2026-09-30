import { IRiskRepository, PrismaRiskRepository, InMemoryRiskRepository } from './risk.repository.js';
import { RiskService } from './risk.service.js';
import { RiskController } from './risk.controller.js';
import { RiskEngineConsumer } from './risk-consumer.service.js';
import { createDefaultRiskRules } from './risk.rules.js';
import { checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../../common/logger.js';
import { getKafkaProducerService } from '../../infra/kafka/kafka-producer.js';
import { getRedisClient } from '../../infra/redis/redis.client.js';

export interface RiskContainer {
  repository: IRiskRepository;
  service: RiskService;
  controller: RiskController;
  consumer: RiskEngineConsumer;
}

let activeContainer: RiskContainer | null = null;

export async function createRiskContainer(options?: {
  repository?: IRiskRepository;
}): Promise<RiskContainer> {
  let repository = options?.repository;

  if (!repository) {
    if (process.env.NODE_ENV === 'test') {
      repository = new InMemoryRiskRepository();
    } else {
      const dbHealth = await checkDatabaseHealth();
      if (dbHealth.connected) {
        logger.info('Using PrismaRiskRepository (PostgreSQL connected)');
        repository = new PrismaRiskRepository();
      } else {
        logger.info('PostgreSQL not connected; initializing In-Memory Risk Repository');
        repository = new InMemoryRiskRepository();
      }
    }
  }

  const kafkaProducer = getKafkaProducerService();
  const rules = createDefaultRiskRules(getRedisClient);
  const service = new RiskService(repository, rules, kafkaProducer);
  const controller = new RiskController(service);
  const consumer = new RiskEngineConsumer({ riskService: service });

  return {
    repository,
    service,
    controller,
    consumer,
  };
}

export async function getRiskContainer(): Promise<RiskContainer> {
  if (!activeContainer) {
    activeContainer = await createRiskContainer();
  }
  return activeContainer;
}

export function setRiskContainer(container: RiskContainer): void {
  activeContainer = container;
}

export function resetRiskContainer(): void {
  activeContainer = null;
}
