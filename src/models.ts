import { Schema, Types, model } from 'mongoose';

const objectId = Schema.Types.ObjectId;
const isTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

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
    timezone: { type: String, required: true, validate: { validator: isTimezone, message: 'Invalid IANA timezone' } },
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

const adminUserSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['ADMIN', 'STAFF'], default: 'ADMIN' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
adminUserSchema.index({ appId: 1, email: 1 }, { unique: true });

const serviceSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
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

const workingHoursSchema = new Schema(
  {
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    startsAt: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    endsAt: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

const staffSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    name: { type: String, required: true, trim: true },
    resourceType: { type: String, required: true, trim: true },
    workingHours: { type: [workingHoursSchema], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
staffSchema.index({ appId: 1, name: 1 }, { unique: true });

const blockedSlotSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    staffId: { type: objectId, ref: 'Staff', required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    reason: { type: String, default: null },
    createdBy: { type: objectId, ref: 'AdminUser', default: null },
  },
  { timestamps: true },
);
blockedSlotSchema.index({ appId: 1, staffId: 1, startsAt: 1, endsAt: 1 });

const customerSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    dataEncrypted: { type: String, required: true },
    phoneLookupHash: { type: String, default: null },
  },
  { timestamps: true },
);
customerSchema.index({ appId: 1, phoneLookupHash: 1 });

const appointmentSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    staffId: { type: objectId, ref: 'Staff', required: true, index: true },
    serviceId: { type: objectId, ref: 'Service', required: true },
    customerId: { type: objectId, ref: 'Customer', default: null },
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

const slotClaimSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true },
    staffId: { type: objectId, ref: 'Staff', required: true },
    minute: { type: Date, required: true },
    sourceId: { type: objectId, required: true },
    sourceType: { type: String, enum: ['APPOINTMENT', 'BLOCK'], required: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);
slotClaimSchema.index({ appId: 1, staffId: 1, minute: 1 }, { unique: true });
slotClaimSchema.index({ sourceId: 1 });
slotClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const waitlistSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    staffId: { type: objectId, ref: 'Staff', required: true },
    serviceId: { type: objectId, ref: 'Service', default: null },
    requestedDate: { type: String, required: true },
    contactDataEncrypted: { type: String, required: true },
    status: { type: String, enum: ['WAITING', 'NOTIFIED', 'FULFILLED', 'CANCELLED'], default: 'WAITING' },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
waitlistSchema.index({ appId: 1, staffId: 1, requestedDate: 1, status: 1 });

const outboxSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    eventType: { type: String, required: true },
    aggregateId: { type: objectId, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    secretPayloadEncrypted: { type: String, default: null },
    status: { type: String, enum: ['PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED'], default: 'PENDING' },
    attemptCount: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    lockedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);
outboxSchema.index({ status: 1, availableAt: 1 });

const bookingOtpSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true },
    appointmentId: { type: objectId, ref: 'Appointment', required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
bookingOtpSchema.index({ appointmentId: 1, expiresAt: -1 });
bookingOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const auditLogSchema = new Schema(
  {
    appId: { type: objectId, ref: 'App', required: true, index: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: objectId, default: null },
    action: { type: String, required: true },
    actorType: { type: String, enum: ['APP', 'ADMIN', 'CUSTOMER', 'SYSTEM'], required: true },
    actorId: { type: String, default: null },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ appId: 1, aggregateType: 1, aggregateId: 1, createdAt: 1 });

export const AppModel = model('App', appSchema);
export const AdminUserModel = model('AdminUser', adminUserSchema);
export const ServiceModel = model('Service', serviceSchema);
export const StaffModel = model('Staff', staffSchema);
export const BlockedSlotModel = model('BlockedSlot', blockedSlotSchema);
export const CustomerModel = model('Customer', customerSchema);
export const AppointmentModel = model('Appointment', appointmentSchema);
export const SlotClaimModel = model('SlotClaim', slotClaimSchema);
export const WaitlistModel = model('Waitlist', waitlistSchema);
export const OutboxModel = model('Outbox', outboxSchema);
export const BookingOtpModel = model('BookingOtp', bookingOtpSchema);
export const AuditLogModel = model('AuditLog', auditLogSchema);

export { Types };
