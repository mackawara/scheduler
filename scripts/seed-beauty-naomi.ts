import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApiKey, encryptJson, hashPassword } from '../src/lib/crypto.js';
import { closeDatabase, connectDatabase } from '../src/db.js';
import {
  AdminUserModel,
  AppModel,
  AppointmentModel,
  AuditLogModel,
  BlockedSlotModel,
  BookingOtpModel,
  CustomerModel,
  OutboxModel,
  ServiceModel,
  SlotClaimModel,
  StaffModel,
  WaitlistModel,
} from '../src/models/index.js';
import { env } from '../src/config.js';

type Seed = {
  app: {
    slug: string;
    name: string;
    timezone: string;
    address: string | null;
    holdTtlMinutes: number;
    rescheduleCutoffHours: number;
    slotIntervalMinutes: number;
  };
  adminEmail: string;
  services: Array<{
    name: string;
    description?: string;
    baseDurationMinutes: number;
    bufferDurationMinutes: number;
    resourceType: string;
    priceCents: number;
    currency: string;
  }>;
  staff: Array<{
    name: string;
    resourceType: string;
    workingHours: Array<{ dayOfWeek: number; startsAt: string; endsAt: string }>;
  }>;
};

const password = process.env.BEAUTY_NAOMI_ADMIN_PASSWORD;
if (!password || password.length < 12) {
  throw new Error('BEAUTY_NAOMI_ADMIN_PASSWORD must be set to at least 12 characters');
}

const seed = JSON.parse(
  await readFile(resolve(process.cwd(), 'config/beauty-naomi.seed.json'), 'utf8'),
) as Seed;
await connectDatabase();

try {
  const models = [
    AppModel,
    AdminUserModel,
    ServiceModel,
    StaffModel,
    BlockedSlotModel,
    CustomerModel,
    AppointmentModel,
    SlotClaimModel,
    WaitlistModel,
    OutboxModel,
    BookingOtpModel,
    AuditLogModel,
  ];
  await Promise.all(models.map((model) => model.createIndexes()));

  let app = await AppModel.findOne({ slug: seed.app.slug });
  let visibleApiKey: string | null = null;
  if (!app) {
    const apiKey = createApiKey();
    visibleApiKey = apiKey.key;
    app = await AppModel.create({
      ...seed.app,
      apiKeyPrefix: apiKey.prefix,
      apiKeyHash: apiKey.hash,
      webhookUrl: process.env.BEAUTY_NAOMI_WEBHOOK_URL ?? null,
    });
  } else {
    app.set({ ...seed.app, webhookUrl: process.env.BEAUTY_NAOMI_WEBHOOK_URL ?? app.webhookUrl });
    if (process.env.ROTATE_API_KEY === 'true') {
      const apiKey = createApiKey();
      visibleApiKey = apiKey.key;
      app.set({ apiKeyPrefix: apiKey.prefix, apiKeyHash: apiKey.hash });
    }
    await app.save();
  }

  let visibleWebhookSecret: string | null = null;
  if (app.webhookUrl && (!app.webhookSecretEncrypted || process.env.ROTATE_WEBHOOK_SECRET === 'true')) {
    visibleWebhookSecret = createApiKey().key;
    app.webhookSecretEncrypted = encryptJson({ secret: visibleWebhookSecret }, env.encryptionKey);
    await app.save();
  }

  await AdminUserModel.findOneAndUpdate(
    { appId: app._id, email: seed.adminEmail.toLowerCase() },
    {
      $set: { passwordHash: await hashPassword(password), role: 'ADMIN', active: true },
      $setOnInsert: { appId: app._id, email: seed.adminEmail.toLowerCase() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  for (const service of seed.services) {
    await ServiceModel.findOneAndUpdate(
      { appId: app._id, name: service.name },
      { $set: { ...service, active: true }, $setOnInsert: { appId: app._id } },
      { upsert: true },
    );
  }
  for (const staff of seed.staff) {
    await StaffModel.findOneAndUpdate(
      { appId: app._id, name: staff.name },
      { $set: { ...staff, active: true }, $setOnInsert: { appId: app._id } },
      { upsert: true },
    );
  }

  console.log(`Beauty Naomi app id: ${app._id.toString()}`);
  console.log(`Admin login: ${seed.adminEmail}`);
  console.log(visibleApiKey ? `API key (save now): ${visibleApiKey}` : 'API key unchanged; set ROTATE_API_KEY=true to rotate it.');
  if (visibleWebhookSecret) console.log(`Webhook signing secret (save now): ${visibleWebhookSecret}`);
} finally {
  await closeDatabase();
}
