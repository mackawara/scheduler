import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config.js';
import { closeDatabase, connectDatabase } from './db.js';
import { logger } from './lib/logger.js';
import { closeRedis, connectRedis } from './redis.js';

await connectDatabase();
await connectRedis();

const server = createServer(createApp());
server.listen(env.PORT, () => logger.info('Scheduler API listening', { port: env.PORT }));
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });
  server.close(async () => {
    await Promise.all([closeDatabase(), closeRedis()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
