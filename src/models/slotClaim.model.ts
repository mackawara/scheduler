import { Schema, model } from 'mongoose';

const slotClaimSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true },
    minute: { type: Date, required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    sourceType: { type: String, enum: ['APPOINTMENT', 'BLOCK'], required: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

slotClaimSchema.index({ appId: 1, staffId: 1, minute: 1 }, { unique: true });
slotClaimSchema.index({ sourceId: 1 });
slotClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SlotClaimModel = model('SlotClaim', slotClaimSchema);