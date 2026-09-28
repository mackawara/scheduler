import { Schema, model } from 'mongoose';

const bookingOtpSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

bookingOtpSchema.index({ appointmentId: 1, expiresAt: -1 });
bookingOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const BookingOtpModel = model('BookingOtp', bookingOtpSchema);