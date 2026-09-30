import { Request, Response, NextFunction } from 'express';
import { WebhookService } from './webhook.service.js';
import { WebhookEventStatus, DeadLetterStatus } from './webhook.types.js';
import { ValidationError } from '../../common/errors.js';

export class WebhookController {
  constructor(private readonly service: WebhookService) {}

  /**
   * Ingest webhook from provider (e.g. POST /api/v1/webhooks/:provider)
   */
  public ingestWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const provider = (req.params.provider || '').trim();
      const correlationId = (req as any).correlationId;
      const signature =
        (req.headers['x-mockpay-signature'] as string) ||
        (req.headers['x-webhook-signature'] as string) ||
        (req.headers['x-signature'] as string) ||
        undefined;

      const rawBody = (req as any).rawBody || JSON.stringify(req.body || {});

      const result = await this.service.ingestWebhook({
        provider,
        rawBody,
        signature,
        correlationId,
      });

      res.status(result.duplicate ? 200 : 202).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * List webhook events (GET /api/v1/webhooks)
   */
  public listWebhooks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { provider, event_type, status, from, to, page, limit } = req.query;

      const filter = {
        provider: typeof provider === 'string' ? provider : undefined,
        eventType: typeof event_type === 'string' ? event_type : undefined,
        status: typeof status === 'string' ? (status as WebhookEventStatus) : undefined,
        from: typeof from === 'string' ? new Date(from) : undefined,
        to: typeof to === 'string' ? new Date(to) : undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 50,
      };

      const result = await this.service.listWebhooks(filter);
      res.status(200).json({
        success: true,
        data: result.events,
        pagination: {
          total: result.total,
          page: filter.page,
          limit: filter.limit,
          totalPages: Math.ceil(result.total / filter.limit) || 1,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Get single webhook event by ID (GET /api/v1/webhooks/:id)
   */
  public getWebhookById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const event = await this.service.getWebhookById(id);
      res.status(200).json({
        success: true,
        data: event,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * List dead letter queue events (GET /api/v1/webhooks/dead-letter)
   */
  public listDeadLetterEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { status, event_type, page, limit } = req.query;

      const filter = {
        status: typeof status === 'string' ? (status as DeadLetterStatus) : undefined,
        eventType: typeof event_type === 'string' ? event_type : undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 50,
      };

      const result = await this.service.listDeadLetterEvents(filter);
      res.status(200).json({
        success: true,
        data: result.events,
        pagination: {
          total: result.total,
          page: filter.page,
          limit: filter.limit,
          totalPages: Math.ceil(result.total / filter.limit) || 1,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Get dead letter queue event by ID (GET /api/v1/webhooks/dead-letter/:id)
   */
  public getDeadLetterEventById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const event = await this.service.getDeadLetterEventById(id);
      res.status(200).json({
        success: true,
        data: event,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Replay dead letter queue event (POST /api/v1/webhooks/dead-letter/:id/retry)
   */
  public retryDeadLetterEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const actorId = (req as any).user?.id || 'admin_operator';
      const event = await this.service.replayDeadLetterEvent(id, actorId);
      res.status(200).json({
        success: true,
        message: 'Event safely re-queued for processing',
        data: event,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Resolve dead letter queue event (POST /api/v1/webhooks/dead-letter/:id/resolve)
   */
  public resolveDeadLetterEvent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params.id as string;
      const { resolution_notes } = req.body || {};
      if (!resolution_notes || typeof resolution_notes !== 'string') {
        throw new ValidationError('resolution_notes is required to mark dead letter event as resolved');
      }

      const actorId = (req as any).user?.id || 'admin_operator';
      const event = await this.service.resolveDeadLetterEvent(id, resolution_notes, actorId);
      res.status(200).json({
        success: true,
        message: 'Dead letter event marked as resolved',
        data: event,
      });
    } catch (err) {
      next(err);
    }
  };
}
