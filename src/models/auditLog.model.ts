import { Schema, model } from 'mongoose';

const auditLogSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: Schema.Types.ObjectId, default: null },
    action: { type: String, required: true },
    actorType: { type: String, enum: ['APP', 'ADMIN', 'CUSTOMER', 'SYSTEM'], required: true },
    actorId: { type: String, default: null },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ appId: 1, aggregateType: 1, aggregateId: 1, createdAt: 1 });

export const AuditLogModel = model('AuditLog', auditLogSchema);