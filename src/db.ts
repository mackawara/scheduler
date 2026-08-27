import mongoose, { type ClientSession } from 'mongoose';
import { env } from './config.js';
import { logger } from './lib/logger.js';

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, { maxPoolSize: 50, minPoolSize: 2 });
  logger.info('MongoDB connected');
}

export async function withMongoTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
  } finally {
    await session.endSession();
  }
}

export async function closeDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export { mongoose };
