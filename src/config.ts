import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().url().optional(),
  PII_ENCRYPTION_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  DEV_EXPOSE_OTP: z.string().default('false').transform((value) => value === 'true'),
  OUTBOX_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

const encryptionKey = Buffer.from(parsed.data.PII_ENCRYPTION_KEY, 'base64');
if (encryptionKey.length !== 32) {
  throw new Error('PII_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
}

export const env = { ...parsed.data, encryptionKey };
