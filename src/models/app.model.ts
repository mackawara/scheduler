import { Schema, model } from 'mongoose';
import { isTimezone } from '../utils/timezone.js';

const appSchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },
    name: { type: String, required: true, trim: true },
    timezone: {
      type: String,
      required: true,
      validate: { validator: isTimezone, message: 'Invalid IANA timezone' },
    },
    address: { type: String, default: null },
    holdTtlMinutes: { type: Number, required: true, default: 5, min: 1, max: 60 },
    rescheduleCutoffHours: { type: Number, required: true, default: 4, min: 0, max: 168 },
    slotIntervalMinutes: { type: Number, required: true, default: 15, min: 5, max: 120 },
    apiKeyPrefix: { type: String, required: true, unique: true },
    apiKeyHash: { type: String, required: true },
    webhookUrl: { type: String, default: null },
    webhookSecretEncrypted: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const AppModel = model('App', appSchema);