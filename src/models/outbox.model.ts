import { Schema, model } from 'mongoose';

const outboxSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    eventType: { type: String, required: true },
    aggregateId: { type: Schema.Types.ObjectId, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    secretPayloadEncrypted: { type: String, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
    },
    attemptCount: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    lockedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

outboxSchema.index({ status: 1, availableAt: 1 });

export const OutboxModel = model('Outbox', outboxSchema);