import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { mongoose } from './db.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { redis } from './redis.js';
import { adminAuthRoutes, adminRoutes } from './routes/admin-routes.js';
import { appRoutes } from './routes/app-routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.http('Request completed', {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        appId: req.tenant?.id,
      });
    });
    next();
  });

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (_req, res) => {
    const mongoReady = mongoose.connection.readyState === 1;
    const redisReady = !redis || redis.status === 'ready';
    res.status(mongoReady ? 200 : 503).json({
      status: mongoReady ? 'ready' : 'not_ready',
      dependencies: { mongodb: mongoReady, redis: redisReady },
    });
  });
  app.use('/api/admin/auth', adminAuthRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', appRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
