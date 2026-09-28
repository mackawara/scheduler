import { Schema, model } from 'mongoose';

const appointmentSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true, index: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    status: { type: String, enum: ['HOLD', 'BOOKED', 'CANCELLED', 'EXPIRED'], required: true },
    startsAt: { type: Date, required: true },
    serviceEndsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    holdExpiresAt: { type: Date, default: null },
    customerDataEncrypted: { type: String, default: null },
    cancellationReason: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
    paymentReference: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

appointmentSchema.index(
  { appId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
appointmentSchema.index({ appId: 1, staffId: 1, startsAt: 1, endsAt: 1, status: 1 });
appointmentSchema.index({ status: 1, holdExpiresAt: 1 });

export const AppointmentModel = model('Appointment', appointmentSchema);