import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from './config.js';
import { logger } from './lib/logger.js';
import { HttpError } from './lib/errors.js';

export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : null;
redis?.on('error', (error) => logger.debug('Redis client error', { error: error.message }));

export async function connectRedis(): Promise<void> {
  if (!redis) {
    logger.warn('Redis is not configured; cache and advisory locks are disabled');
    return;
  }
  try {
    await redis.connect();
    logger.info('Redis connected');
  } catch (error) {
    logger.warn('Redis unavailable; MongoDB uniqueness remains the booking integrity boundary', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export async function closeRedis(): Promise<void> {
  if (redis?.status === 'ready') await redis.quit();
}

export async function withDistributedLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (!redis || redis.status !== 'ready') return work();
  const token = randomUUID();
  const lockKey = `lock:${key}`;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    let acquired: string | null;
    try {
      acquired = await redis.set(lockKey, token, 'PX', 10_000, 'NX');
    } catch (error) {
      logger.warn('Redis lock unavailable; continuing with MongoDB uniqueness', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return work();
    }
    if (acquired === 'OK') {
      try {
        return await work();
      } finally {
        try {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            lockKey,
            token,
          );
        } catch (error) {
          logger.warn('Redis lock release failed', { error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new HttpError(503, 'SCHEDULER_BUSY', 'The scheduler is busy; please retry shortly');
}

export async function availabilityVersion(appId: string, staffId: string, date: string): Promise<string> {
  if (!redis || redis.status !== 'ready') return '0:0';
  try {
    const [staffVersion, dateVersion] = await redis.mget(
      `availability-version:${appId}:${staffId}`,
      `availability-version:${appId}:${staffId}:${date}`,
    );
    return `${staffVersion ?? '0'}:${dateVersion ?? '0'}`;
  } catch {
    return '0:0';
  }
}

export async function invalidateAvailability(appId: string, staffId: string, date?: string): Promise<void> {
  if (!redis || redis.status !== 'ready') return;
  const key = date
    ? `availability-version:${appId}:${staffId}:${date}`
    : `availability-version:${appId}:${staffId}`;
  try {
    await redis.incr(key);
  } catch (error) {
    logger.warn('Availability cache invalidation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
