import { Router, Request, Response, NextFunction } from 'express';
import { LedgerController } from './ledger.controller.js';
import { getLedgerContainer } from './ledger.container.js';

export function createLedgerRouter(controller?: LedgerController): Router {
  const router = Router();

  const getCtrl = async (): Promise<LedgerController> => {
    if (controller) return controller;
    const container = await getLedgerContainer();
    return container.controller;
  };

  const handler =
    (method: keyof LedgerController) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const ctrl = await getCtrl();
        const action = ctrl[method] as (req: Request, res: Response, next: NextFunction) => Promise<void>;
        await action(req, res, next);
      } catch (err) {
        next(err);
      }
    };

  // Integrity Check
  router.get('/integrity', handler('checkIntegrity'));

  // Account endpoints
  router.get('/accounts/:id', handler('getAccount'));
  router.get('/accounts/:id/entries', handler('getAccountEntries'));

  // Transaction endpoints
  router.get('/transactions', handler('listTransactions'));
  router.get('/transactions/:id', handler('getTransaction'));

  return router;
}

export const ledgerRouter = createLedgerRouter();
