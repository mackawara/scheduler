import { createApiKey, createPublicKey, encryptJson, hashPassword } from '../src/lib/crypto.js';
import { closeDatabase, connectDatabase } from '../src/db.js';
import { AdminUserModel, AppModel } from '../src/models.js';
import { env } from '../src/config.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const slug = argument('slug');
const name = argument('name');
const timezone = argument('timezone');
const adminEmail = argument('admin-email');
const adminPassword = process.env.APP_ADMIN_PASSWORD;
if (!slug || !name || !timezone || !adminEmail || !adminPassword || adminPassword.length < 12) {
  throw new Error(
    'Usage: APP_ADMIN_PASSWORD=<12+ chars> npm run app:create -- --slug <slug> --name <name> --timezone <IANA zone> --admin-email <email> [--webhook-url <url>]',
  );
}

await connectDatabase();
try {
  await Promise.all([AppModel.createIndexes(), AdminUserModel.createIndexes()]);
  if (await AppModel.exists({ slug })) throw new Error(`An app with slug '${slug}' already exists`);
  const apiKey = createApiKey();
  const publicKey = createPublicKey();
  const webhookUrl = argument('webhook-url') ?? null;
  const webhookSecret = webhookUrl ? createApiKey().key : null;
  const app = await AppModel.create({
    slug,
    name,
    timezone,
    apiKeyPrefix: apiKey.prefix,
    apiKeyHash: apiKey.hash,
    publicKeyPrefix: publicKey.prefix,
    publicKeyHash: publicKey.hash,
    webhookUrl,
    webhookSecretEncrypted: webhookSecret
      ? encryptJson({ secret: webhookSecret }, env.encryptionKey)
      : null,
  });
  await AdminUserModel.create({
    appId: app._id,
    email: adminEmail.toLowerCase(),
    passwordHash: await hashPassword(adminPassword),
    role: 'ADMIN',
  });
  console.log(`App id: ${app._id.toString()}`);
  console.log(`Secret API key (save now, server-side only): ${apiKey.key}`);
  console.log(`Publishable key (safe for browser bundles): ${publicKey.key}`);
  if (webhookSecret) console.log(`Webhook signing secret (save now): ${webhookSecret}`);
} finally {
  await closeDatabase();
}
