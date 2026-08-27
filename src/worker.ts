import { createHmac } from 'node:crypto';
import { DateTime } from 'luxon';
import { env } from './config.js';
import { closeDatabase, connectDatabase, withMongoTransaction } from './db.js';
import { decryptJson } from './lib/crypto.js';
import { logger } from './lib/logger.js';
import { AppModel, AppointmentModel, AuditLogModel, OutboxModel, SlotClaimModel } from './models.js';
import { closeRedis, connectRedis, invalidateAvailability } from './redis.js';

let running = true;

async function expireHolds(): Promise<void> {
  const expired = await AppointmentModel.find({ status: 'HOLD', holdExpiresAt: { $lte: new Date() } })
    .limit(100)
    .lean();
  for (const hold of expired) {
    const changed = await withMongoTransaction(async (session) => {
      const result = await AppointmentModel.updateOne(
        { _id: hold._id, status: 'HOLD', holdExpiresAt: { $lte: new Date() } },
        { $set: { status: 'EXPIRED' } },
        { session },
      );
      if (!result.modifiedCount) return false;
      await SlotClaimModel.deleteMany({ sourceId: hold._id }).session(session);
      await AuditLogModel.create(
        [
          {
            appId: hold.appId,
            aggregateType: 'APPOINTMENT',
            aggregateId: hold._id,
            action: 'HOLD_EXPIRED',
            actorType: 'SYSTEM',
            oldValue: { status: 'HOLD' },
            newValue: { status: 'EXPIRED' },
          },
        ],
        { session },
      );
      return true;
    });
    if (changed) {
      const app = await AppModel.findById(hold.appId).select({ timezone: 1 }).lean();
      if (app) {
        const date = DateTime.fromJSDate(hold.startsAt).setZone(app.timezone).toISODate()!;
        await invalidateAvailability(hold.appId.toString(), hold.staffId.toString(), date);
      }
    }
  }
}

async function deliverOne(): Promise<boolean> {
  await OutboxModel.updateMany(
    { status: 'PROCESSING', lockedAt: { $lte: new Date(Date.now() - 5 * 60_000) } },
    { $set: { status: 'PENDING', lockedAt: null } },
  );
  const event = await OutboxModel.findOneAndUpdate(
    { status: 'PENDING', availableAt: { $lte: new Date() } },
    { $set: { status: 'PROCESSING', lockedAt: new Date() } },
    { sort: { availableAt: 1 }, returnDocument: 'after' },
  ).lean();
  if (!event) return false;

  try {
    const app = await AppModel.findById(event.appId).lean();
    if (!app?.webhookUrl || !app.webhookSecretEncrypted) throw new Error('No notification webhook is configured');
    const { secret } = decryptJson<{ secret: string }>(app.webhookSecretEncrypted, env.encryptionKey);
    const securePayload = event.secretPayloadEncrypted
      ? decryptJson<Record<string, unknown>>(event.secretPayloadEncrypted, env.encryptionKey)
      : {};
    const body = JSON.stringify({
      id: event._id.toString(),
      type: event.eventType,
      createdAt: event.createdAt.toISOString(),
      data: { ...(event.payload as object), ...securePayload },
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const response = await fetch(app.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-scheduler-event-id': event._id.toString(),
        'x-scheduler-signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    await OutboxModel.updateOne(
      { _id: event._id },
      { $set: { status: 'DELIVERED', deliveredAt: new Date(), lockedAt: null }, $inc: { attemptCount: 1 } },
    );
  } catch (error) {
    const attempt = event.attemptCount + 1;
    const retryDelaysSeconds = [60, 300, 900];
    const retryDelay = retryDelaysSeconds[attempt - 1];
    await OutboxModel.updateOne(
      { _id: event._id },
      {
        $set: {
          status: retryDelay ? 'PENDING' : 'FAILED',
          availableAt: retryDelay ? new Date(Date.now() + retryDelay * 1000) : event.availableAt,
          lockedAt: null,
          lastError: error instanceof Error ? error.message.slice(0, 500) : 'Unknown delivery error',
        },
        $inc: { attemptCount: 1 },
      },
    );
    logger.warn('Outbox delivery failed', {
      eventId: event._id.toString(),
      eventType: event.eventType,
      attempt,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  return true;
}

async function tick(): Promise<void> {
  await expireHolds();
  for (let index = 0; index < 25 && (await deliverOne()); index += 1) {
    // Drain a bounded batch before yielding to the next poll.
  }
}

await connectDatabase();
await connectRedis();
logger.info('Scheduler worker started');
process.on('SIGTERM', () => {
  running = false;
});
process.on('SIGINT', () => {
  running = false;
});

while (running) {
  try {
    await tick();
  } catch (error) {
    logger.error('Worker tick failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
  await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_MS));
}

await Promise.all([closeDatabase(), closeRedis()]);
logger.info('Scheduler worker stopped');
