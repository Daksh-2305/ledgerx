import {
  IPaymentRepository,
  InMemoryPaymentRepository,
  PrismaPaymentRepository,
} from './payment.repository.js';
import { PaymentService } from './payment.service.js';
import { PaymentController } from './payment.controller.js';
import { checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../../common/logger.js';

import { getLedgerContainer } from '../ledger/ledger.container.js';
import type { LedgerService } from '../ledger/ledger.service.js';

export interface PaymentModuleContainer {
  repository: IPaymentRepository;
  service: PaymentService;
  controller: PaymentController;
}

let activeContainer: PaymentModuleContainer | null = null;

export async function createPaymentContainer(
  customRepository?: IPaymentRepository,
  customLedgerService?: LedgerService
): Promise<PaymentModuleContainer> {
  const ledgerService = customLedgerService || (await getLedgerContainer()).service;

  if (customRepository) {
    const service = new PaymentService(customRepository, ledgerService);
    const controller = new PaymentController(service);
    return { repository: customRepository, service, controller };
  }

  if (process.env.NODE_ENV === 'test') {
    logger.info('Initializing In-Memory Payment Repository for test environment');
    const inMem = new InMemoryPaymentRepository();
    await seedDemoData(inMem);
    const service = new PaymentService(inMem, ledgerService);
    const controller = new PaymentController(service);
    return { repository: inMem, service, controller };
  }

  // Detect if live database is reachable
  const dbHealth = await checkDatabaseHealth();
  let repository: IPaymentRepository;

  if (dbHealth.connected) {
    logger.info('Using PrismaPaymentRepository (PostgreSQL connected)');
    repository = new PrismaPaymentRepository();
  } else {
    logger.info('PostgreSQL not currently connected; initializing In-Memory Payment Repository');
    const inMem = new InMemoryPaymentRepository();
    await seedDemoData(inMem);
    repository = inMem;
  }

  const service = new PaymentService(repository, ledgerService);
  const controller = new PaymentController(service);

  return { repository, service, controller };
}

export async function seedDemoData(repository: IPaymentRepository): Promise<void> {
  const merchant1 = {
    id: '00000000-0000-0000-0000-000000000001',
    businessName: 'Acme Payments India',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const merchant2 = {
    id: '00000000-0000-0000-0000-000000000002',
    businessName: 'Globex Global Tech',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const customer1 = {
    id: '00000000-0000-0000-0000-000000000010',
    merchantId: merchant1.id,
    name: 'Rahul Sharma',
    email: 'rahul.sharma@example.com',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const customer2 = {
    id: '00000000-0000-0000-0000-000000000020',
    merchantId: merchant2.id,
    name: 'Sarah Connor',
    email: 'sarah.connor@example.com',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await repository.saveMerchant(merchant1);
  await repository.saveMerchant(merchant2);
  await repository.saveCustomer(customer1);
  await repository.saveCustomer(customer2);
}

export async function getPaymentContainer(): Promise<PaymentModuleContainer> {
  if (!activeContainer) {
    activeContainer = await createPaymentContainer();
  }
  return activeContainer;
}

export function setPaymentContainer(container: PaymentModuleContainer): void {
  activeContainer = container;
}

export function resetPaymentContainer(): void {
  activeContainer = null;
}
