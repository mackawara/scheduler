import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues },
    });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
    return;
  }

  const databaseError = error as { code?: number | string };
  if (databaseError.code === 11000) {
    res.status(409).json({
      error: { code: 'SLOT_UNAVAILABLE', message: 'That time is no longer available' },
    });
    return;
  }
  logger.error('Unhandled request error', { error: error instanceof Error ? error.message : 'Unknown error' });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};
