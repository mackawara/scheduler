import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function keyedLookupHash(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value.trim()).digest('hex');
}

export function safeEqualHex(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptJson<T>(value: string, key: Buffer): T {
  const [version, ivPart, tagPart, ciphertextPart] = value.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Unsupported encrypted payload');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function createApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('hex');
  const key = `sk_sched_${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, prefix, hash: sha256(key) };
}

export function parseApiKeyPrefix(key: string): string | null {
  const match = /^sk_sched_([a-f0-9]{12})_[A-Za-z0-9_-]{32}$/.exec(key);
  return match?.[1] ?? null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt.${salt.toString('base64url')}.${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltPart, hashPart] = encoded.split('.');
  if (algorithm !== 'scrypt' || !saltPart || !hashPart) return false;
  const expected = Buffer.from(hashPart, 'base64url');
  const actual = (await scrypt(password, Buffer.from(saltPart, 'base64url'), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomOtp(): string {
  const value = randomBytes(4).readUInt32BE() % 1_000_000;
  return value.toString().padStart(6, '0');
}
