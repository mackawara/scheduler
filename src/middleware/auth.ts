import type { NextFunction, Request, Response } from 'express';
import { parseApiKeyPrefix, parsePublicKeyPrefix, safeEqualHex, sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import { AppModel } from '../models.js';
import type { AppTenant, KeyScope } from '../types.js';

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
  publicKeyPrefix?: string | null;
  publicKeyHash?: string | null;
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

async function resolveKey(key: string): Promise<{ app: AppDocument; scope: KeyScope }> {
  const invalid = new HttpError(401, 'INVALID_API_KEY', 'A valid x-api-key header is required');
  const secretPrefix = parseApiKeyPrefix(key);
  if (secretPrefix) {
    const app = (await AppModel.findOne({ apiKeyPrefix: secretPrefix, active: true }).lean()) as AppDocument | null;
    if (!app || !safeEqualHex(sha256(key), app.apiKeyHash)) throw invalid;
    return { app, scope: 'SECRET' };
  }
  const publicPrefix = parsePublicKeyPrefix(key);
  if (publicPrefix) {
    const app = (await AppModel.findOne({ publicKeyPrefix: publicPrefix, active: true }).lean()) as AppDocument | null;
    if (!app?.publicKeyHash || !safeEqualHex(sha256(key), app.publicKeyHash)) throw invalid;
    return { app, scope: 'PUBLIC' };
  }
  throw invalid;
}

/**
 * Accepts a secret or a publishable key. Routes that expose stored personal
 * data must additionally guard with `requireSecretKey`.
 */
export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { app, scope } = await resolveKey(req.get('x-api-key') ?? '');
    req.tenant = mapTenant(app);
    req.keyScope = scope;
    next();
  } catch (error) {
    next(error);
  }
}

/** Blocks publishable keys; use on any route that returns another person's data. */
export function requireSecretKey(req: Request, _res: Response, next: NextFunction): void {
  if (req.keyScope !== 'SECRET') {
    next(new HttpError(403, 'SECRET_KEY_REQUIRED', 'This route requires the secret API key'));
    return;
  }
  next();
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
    } else if (claims.type === 'CUSTOMER' && claims.customerId) {
      // Ownership of this specific booking is checked by the service layer,
      // which has the appointment's customerId to compare against.
      req.principal = { type: 'CUSTOMER', id: claims.sub, appId: claims.aud, customerId: claims.customerId };
    } else {
      throw new HttpError(403, 'BOOKING_ACCESS_DENIED', 'The token cannot manage this booking');
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Requires a customer-wide token minted by phone OTP or an account login. */
export function customerAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!req.tenant) throw new HttpError(401, 'INVALID_API_KEY', 'App authentication is required');
    const claims = verifyToken(bearer(req));
    if (claims.aud !== req.tenant.id) throw new HttpError(403, 'WRONG_TENANT', 'The token belongs to another app');
    if (claims.type !== 'CUSTOMER' || !claims.customerId) {
      throw new HttpError(403, 'CUSTOMER_REQUIRED', 'A customer token is required');
    }
    req.principal = { type: 'CUSTOMER', id: claims.sub, appId: claims.aud, customerId: claims.customerId };
    next();
  } catch (error) {
    next(error);
  }
}

/** Narrows the request principal to the customer set by `customerAuth`. */
export function customerIdOf(req: Request): string {
  const principal = req.principal;
  if (principal?.type !== 'CUSTOMER' || !principal.customerId) {
    throw new HttpError(403, 'CUSTOMER_REQUIRED', 'A customer token is required');
  }
  return principal.customerId;
}
