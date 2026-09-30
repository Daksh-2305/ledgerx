import { Router, Request, Response, NextFunction } from 'express';
import { PaymentController } from './payment.controller.js';
import { getPaymentContainer } from './payment.container.js';

export function createRefundsRouter(controller?: PaymentController): Router {
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

  // GET /api/v1/refunds/:id
  router.get('/:id', handler('getRefundById'));

  return router;
}

export const refundsRouter = createRefundsRouter();
