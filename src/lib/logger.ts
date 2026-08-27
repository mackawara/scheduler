import winston from 'winston';
import { env } from '../config.js';

const SENSITIVE_KEYS = /^(authorization|x-api-key|password|phone|name|socialHandle|customer|code|paymentToken)$/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(nested),
    ]),
  );
}

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    info[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(info[key]);
  }
  return info;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  defaultMeta: { service: 'scheduler-api' },
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: env.NODE_ENV !== 'production' }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});
