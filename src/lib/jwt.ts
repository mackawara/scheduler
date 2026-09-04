import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { HttpError } from './errors.js';

type TokenClaims = {
  iss: 'scheduler-api';
  aud: string;
  sub: string;
  type: 'ADMIN' | 'CUSTOMER';
  role?: 'ADMIN' | 'STAFF';
  appointmentId?: string;
  customerId?: string;
  iat: number;
  exp: number;
};

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signature(input: string): Buffer {
  return createHmac('sha256', env.JWT_SECRET).update(input).digest();
}

export function signToken(
  claims: Omit<TokenClaims, 'iss' | 'iat' | 'exp'>,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ ...claims, iss: 'scheduler-api', iat: now, exp: now + ttlSeconds });
  const input = `${header}.${payload}`;
  return `${input}.${signature(input).toString('base64url')}`;
}

export function verifyToken(token: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid');
  }
  const input = `${parts[0]}.${parts[1]}`;
  const actual = Buffer.from(parts[2], 'base64url');
  const expected = signature(input);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid');
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid');
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== 'scheduler-api' || claims.exp <= now || !claims.aud || !claims.sub) {
    throw new HttpError(401, 'EXPIRED_TOKEN', 'The access token is invalid or expired');
  }
  return claims;
}
