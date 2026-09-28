import { Schema, model } from 'mongoose';

const waitlistSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', default: null },
    requestedDate: { type: String, required: true },
    contactDataEncrypted: { type: String, required: true },
    status: {
      type: String,
      enum: ['WAITING', 'NOTIFIED', 'FULFILLED', 'CANCELLED'],
      default: 'WAITING',
    },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

waitlistSchema.index({ appId: 1, staffId: 1, requestedDate: 1, status: 1 });

export const WaitlistModel = model('Waitlist', waitlistSchema);