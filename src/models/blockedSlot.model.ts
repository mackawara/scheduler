import { Schema, model } from 'mongoose';

const blockedSlotSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    reason: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: true },
);

blockedSlotSchema.index({ appId: 1, staffId: 1, startsAt: 1, endsAt: 1 });

export const BlockedSlotModel = model('BlockedSlot', blockedSlotSchema);