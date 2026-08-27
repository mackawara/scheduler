import type { NextFunction, Request, Response } from 'express';
import { parseApiKeyPrefix, safeEqualHex, sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import { AppModel } from '../models.js';
import type { AppTenant } from '../types.js';

type AppDocument = {
  _id: { toString(): string };
  slug: string;
  name: string;
  timezone: string;
  address?: string | null;
  holdTtlMinutes: number;
  rescheduleCutoffHours: number;
  slotIntervalMinutes: number;
  apiKeyHash: string;
  webhookUrl?: string | null;
  webhookSecretEncrypted?: string | null;
};

export function mapTenant(row: AppDocument): AppTenant {
  return {
    id: row._id.toString(),
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    address: row.address ?? null,
    holdTtlMinutes: row.holdTtlMinutes,
    rescheduleCutoffHours: row.rescheduleCutoffHours,
    slotIntervalMinutes: row.slotIntervalMinutes,
    webhookUrl: row.webhookUrl ?? null,
    webhookSecretEncrypted: row.webhookSecretEncrypted ?? null,
  };
}

async function loadApp(appId: string): Promise<AppTenant> {
  const app = (await AppModel.findOne({ _id: appId, active: true }).lean()) as AppDocument | null;
  if (!app) throw new HttpError(401, 'INVALID_TOKEN', 'The token is not valid for an active app');
  return mapTenant(app);
}

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const key = req.get('x-api-key') ?? '';
    const prefix = parseApiKeyPrefix(key);
    if (!prefix) throw new HttpError(401, 'INVALID_API_KEY', 'A valid x-api-key header is required');
    const app = (await AppModel.findOne({ apiKeyPrefix: prefix, active: true }).lean()) as AppDocument | null;
    if (!app || !safeEqualHex(sha256(key), app.apiKeyHash)) {
      throw new HttpError(401, 'INVALID_API_KEY', 'A valid x-api-key header is required');
    }
    req.tenant = mapTenant(app);
    next();
  } catch (error) {
    next(error);
  }
}

function bearer(req: Request): string {
  const value = req.get('authorization') ?? '';
  if (!value.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED', 'A bearer token is required');
  return value.slice(7);
}

export async function adminAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const claims = verifyToken(bearer(req));
    if (claims.type !== 'ADMIN' || !claims.role) {
      throw new HttpError(403, 'ADMIN_REQUIRED', 'An admin token is required');
    }
    req.tenant = await loadApp(claims.aud);
    req.principal = { type: 'ADMIN', id: claims.sub, appId: claims.aud, role: claims.role };
    next();
  } catch (error) {
    next(error);
  }
}

export function bookingManagementAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!req.tenant) throw new HttpError(401, 'INVALID_API_KEY', 'App authentication is required');
    const claims = verifyToken(bearer(req));
    if (claims.aud !== req.tenant.id) throw new HttpError(403, 'WRONG_TENANT', 'The token belongs to another app');
    if (claims.type === 'ADMIN' && claims.role) {
      req.principal = { type: 'ADMIN', id: claims.sub, appId: claims.aud, role: claims.role };
    } else if (claims.type === 'CUSTOMER' && claims.appointmentId && claims.appointmentId === req.params.id) {
      req.principal = {
        type: 'CUSTOMER',
        id: claims.sub,
        appId: claims.aud,
        appointmentId: claims.appointmentId,
      };
    } else {
      throw new HttpError(403, 'BOOKING_ACCESS_DENIED', 'The token cannot manage this booking');
    }
    next();
  } catch (error) {
    next(error);
  }
}
