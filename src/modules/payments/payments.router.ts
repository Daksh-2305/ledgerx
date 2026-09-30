import { Router, Request, Response, NextFunction } from 'express';
import { PaymentController } from './payment.controller.js';
import { getPaymentContainer } from './payment.container.js';

export function createPaymentsRouter(controller?: PaymentController): Router {
  const router = Router();

  const getCtrl = async (): Promise<PaymentController> => {
    if (controller) return controller;
    const container = await getPaymentContainer();
    return container.controller;
  };

  const handler =
    (method: keyof PaymentController) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const ctrl = await getCtrl();
        const action = ctrl[method] as (req: Request, res: Response, next: NextFunction) => Promise<void>;
        await action(req, res, next);
      } catch (err) {
        next(err);
      }
    };

  // Payment CRUD
  router.post('/', handler('create'));
  router.get('/', handler('list'));
  router.get('/:id', handler('getById'));

  // Payment State Machine Endpoints
  router.post('/:id/initiate', handler('initiate'));
  router.post('/:id/authorize', handler('authorize'));
  router.post('/:id/capture', handler('capture'));
  router.post('/:id/cancel', handler('cancel'));
  router.post('/:id/fail', handler('fail'));
  router.post('/:id/settle', handler('settle'));

  // Refund Endpoints
  router.post('/:id/refund', handler('refund'));
  router.get('/:id/refunds', handler('listRefunds'));

  return router;
}

export const paymentsRouter = createPaymentsRouter();
