import { Schema, model } from 'mongoose';

const serviceSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    baseDurationMinutes: { type: Number, required: true, min: 1, max: 1440 },
    bufferDurationMinutes: { type: Number, required: true, default: 0, min: 0, max: 240 },
    resourceType: { type: String, required: true, trim: true },
    priceCents: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

serviceSchema.index({ appId: 1, name: 1 }, { unique: true });

export const ServiceModel = model('Service', serviceSchema);