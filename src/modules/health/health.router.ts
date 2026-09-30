import { Router } from 'express';
import { HealthController } from './health.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', HealthController.getLiveness);
healthRouter.get('/ready', HealthController.getReadiness);
healthRouter.get('/health/dependencies', HealthController.getDependencies);
healthRouter.get('/health/detailed', HealthController.getDependencies);
healthRouter.get('/metrics', HealthController.getPrometheusMetrics);
healthRouter.get('/api/v1/info', HealthController.getPlatformInfo);
