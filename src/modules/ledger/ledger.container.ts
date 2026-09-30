import {
  ILedgerRepository,
  InMemoryLedgerRepository,
  PrismaLedgerRepository,
} from './ledger.repository.js';
import { LedgerService } from './ledger.service.js';
import { LedgerController } from './ledger.controller.js';
import { checkDatabaseHealth } from '../../db/client.js';
import { logger } from '../../common/logger.js';

export interface LedgerModuleContainer {
  repository: ILedgerRepository;
  service: LedgerService;
  controller: LedgerController;
}

let activeContainer: LedgerModuleContainer | null = null;

export async function createLedgerContainer(
  customRepository?: ILedgerRepository
): Promise<LedgerModuleContainer> {
  if (customRepository) {
    const service = new LedgerService(customRepository);
    const controller = new LedgerController(service);
    return { repository: customRepository, service, controller };
  }

  if (process.env.NODE_ENV === 'test') {
    logger.info('Initializing In-Memory Ledger Repository for test environment');
    const inMem = new InMemoryLedgerRepository();
    await seedDemoLedgerAccounts(inMem);
    const service = new LedgerService(inMem);
    const controller = new LedgerController(service);
    return { repository: inMem, service, controller };
  }

  const dbHealth = await checkDatabaseHealth();
  let repository: ILedgerRepository;

  if (dbHealth.connected) {
    logger.info('Using PrismaLedgerRepository (PostgreSQL connected)');
    repository = new PrismaLedgerRepository();
  } else {
    logger.info('Initializing In-Memory Ledger Repository');
    const inMem = new InMemoryLedgerRepository();
    await seedDemoLedgerAccounts(inMem);
    repository = inMem;
  }

  const service = new LedgerService(repository);
  const controller = new LedgerController(service);

  return { repository, service, controller };
}

export async function seedDemoLedgerAccounts(repository: ILedgerRepository): Promise<void> {
  const merchant1Id = '00000000-0000-0000-0000-000000000001';
  const merchant2Id = '00000000-0000-0000-0000-000000000002';

  const demoAccounts = [
    // Platform clearing accounts
    {
      id: 'a0000000-0000-0000-0000-000000000001',
      merchantId: null,
      code: 'PAYMENT_CLEARING',
      name: 'Platform Payment Clearing (INR)',
      type: 'CLEARING' as const,
      currency: 'INR',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'a0000000-0000-0000-0000-000000000002',
      merchantId: null,
      code: 'PAYMENT_CLEARING',
      name: 'Platform Payment Clearing (USD)',
      type: 'CLEARING' as const,
      currency: 'USD',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    // Merchant 1 Accounts
    {
      id: 'a0000000-0000-0000-0000-000000000011',
      merchantId: merchant1Id,
      code: 'MERCHANT_SETTLEMENT_RECEIVABLE',
      name: 'Acme Settlement Receivable (INR)',
      type: 'ASSET' as const,
      currency: 'INR',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'a0000000-0000-0000-0000-000000000012',
      merchantId: merchant1Id,
      code: 'MERCHANT_SETTLEMENT_RECEIVABLE',
      name: 'Acme Settlement Receivable (USD)',
      type: 'ASSET' as const,
      currency: 'USD',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    // Merchant 2 Accounts
    {
      id: 'a0000000-0000-0000-0000-000000000021',
      merchantId: merchant2Id,
      code: 'MERCHANT_SETTLEMENT_RECEIVABLE',
      name: 'Globex Settlement Receivable (INR)',
      type: 'ASSET' as const,
      currency: 'INR',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  for (const acc of demoAccounts) {
    await repository.saveAccount(acc);
  }
}

export async function getLedgerContainer(): Promise<LedgerModuleContainer> {
  if (!activeContainer) {
    activeContainer = await createLedgerContainer();
  }
  return activeContainer;
}

export function setLedgerContainer(container: LedgerModuleContainer): void {
  activeContainer = container;
}

export function resetLedgerContainer(): void {
  activeContainer = null;
}
