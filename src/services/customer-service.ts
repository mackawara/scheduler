import { DateTime } from 'luxon';
import { env } from '../config.js';
import { withMongoTransaction } from '../db.js';
import {
  decryptJson,
  encryptJson,
  hashPassword,
  keyedLookupHash,
  randomOtp,
  safeEqualHex,
  sha256,
  verifyPassword,
} from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { signToken } from '../lib/jwt.js';
import {
  AppointmentModel,
  AuditLogModel,
  CustomerModel,
  CustomerOtpModel,
  OutboxModel,
  ServiceModel,
  StaffModel,
  Types,
} from '../models.js';
import type { AppTenant } from '../types.js';

export type CustomerProfile = { name?: string; phone?: string; email?: string; socialHandle?: string };

const CUSTOMER_TOKEN_TTL_SECONDS = 30 * 60;

function customerToken(tenant: AppTenant, customerId: string): { accessToken: string; expiresIn: number } {
  return {
    accessToken: signToken(
      { aud: tenant.id, sub: customerId, type: 'CUSTOMER', customerId },
      CUSTOMER_TOKEN_TTL_SECONDS,
    ),
    expiresIn: CUSTOMER_TOKEN_TTL_SECONDS,
  };
}

function profileOf(row: { dataEncrypted: string }): CustomerProfile {
  return decryptJson<CustomerProfile>(row.dataEncrypted, env.encryptionKey);
}

/**
 * Sends a six-digit code to a phone number so its owner can list and manage
 * their bookings. The response never reveals whether the number is known.
 */
export async function requestCustomerOtp(
  tenant: AppTenant,
  phone: string,
): Promise<{ expiresAt: string; devCode?: string }> {
  const phoneLookupHash = keyedLookupHash(phone, env.encryptionKey);
  const code = randomOtp();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const customer = await CustomerModel.findOne({ appId: tenant.id, phoneLookupHash }).lean();

  await withMongoTransaction(async (session) => {
    await CustomerOtpModel.updateMany(
      { appId: tenant.id, phoneLookupHash, consumedAt: null },
      { $set: { consumedAt: new Date() } },
      { session },
    );
    await CustomerOtpModel.create(
      [{ appId: tenant.id, phoneLookupHash, codeHash: sha256(`${phoneLookupHash}:${code}`), expiresAt }],
      { session },
    );
    // Only notify numbers we already know; an unknown number gets the same
    // response shape but no message, so the endpoint cannot enumerate customers.
    if (customer) {
      await OutboxModel.create(
        [
          {
            appId: tenant.id,
            eventType: 'CUSTOMER_OTP_REQUESTED',
            aggregateId: customer._id,
            payload: { customerId: customer._id.toString() },
            secretPayloadEncrypted: encryptJson({ code, phone }, env.encryptionKey),
          },
        ],
        { session },
      );
    }
  });
  return { expiresAt: expiresAt.toISOString(), ...(env.DEV_EXPOSE_OTP ? { devCode: code } : {}) };
}

export async function verifyCustomerOtp(
  tenant: AppTenant,
  phone: string,
  code: string,
): Promise<{ accessToken: string; expiresIn: number; customer: CustomerProfile }> {
  const phoneLookupHash = keyedLookupHash(phone, env.encryptionKey);
  const invalid = new HttpError(400, 'INVALID_OTP', 'The verification code is invalid or expired');

  const customerId = await withMongoTransaction(async (session) => {
    const otp = await CustomerOtpModel.findOne({
      appId: tenant.id,
      phoneLookupHash,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .session(session)
      .lean();
    if (!otp) throw invalid;
    if (otp.attempts >= 5) throw new HttpError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many verification attempts');
    if (!safeEqualHex(sha256(`${phoneLookupHash}:${code}`), otp.codeHash)) {
      await CustomerOtpModel.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } }, { session });
      return null;
    }
    await CustomerOtpModel.updateOne({ _id: otp._id }, { $set: { consumedAt: new Date() } }, { session });
    const customer = await CustomerModel.findOne({ appId: tenant.id, phoneLookupHash }).session(session).lean();
    if (!customer) throw invalid;
    return customer._id.toString();
  });
  if (!customerId) throw invalid;

  const customer = await CustomerModel.findById(customerId).lean();
  return { ...customerToken(tenant, customerId), customer: profileOf(customer as { dataEncrypted: string }) };
}

/**
 * Creates an account on top of whatever the customer already has. Bookings made
 * as a guest — on the portal or over WhatsApp — are already stored against the
 * phone number, so registering with that number adopts the existing history.
 */
export async function registerCustomer(
  tenant: AppTenant,
  input: { name: string; email: string; password: string; phone: string },
): Promise<{ accessToken: string; expiresIn: number; customer: CustomerProfile }> {
  const emailLookupHash = keyedLookupHash(input.email.toLowerCase(), env.encryptionKey);
  const phoneLookupHash = keyedLookupHash(input.phone, env.encryptionKey);
  const passwordHash = await hashPassword(input.password);

  const customerId = await withMongoTransaction(async (session) => {
    const takenEmail = await CustomerModel.findOne({ appId: tenant.id, emailLookupHash }).session(session).lean();
    if (takenEmail) throw new HttpError(409, 'EMAIL_TAKEN', 'An account already exists for this email address');

    const existing = await CustomerModel.findOne({ appId: tenant.id, phoneLookupHash }).session(session).lean();
    if (existing?.passwordHash) {
      throw new HttpError(409, 'PHONE_TAKEN', 'An account already exists for this phone number');
    }

    const profile: CustomerProfile = {
      ...(existing ? profileOf(existing as { dataEncrypted: string }) : {}),
      name: input.name,
      phone: input.phone,
      email: input.email.toLowerCase(),
    };
    const dataEncrypted = encryptJson(profile, env.encryptionKey);

    if (existing) {
      await CustomerModel.updateOne(
        { _id: existing._id },
        { $set: { dataEncrypted, emailLookupHash, passwordHash, accountCreatedAt: new Date() } },
        { session },
      );
      return existing._id.toString();
    }
    const id = new Types.ObjectId();
    await CustomerModel.create(
      [
        {
          _id: id,
          appId: tenant.id,
          dataEncrypted,
          phoneLookupHash,
          emailLookupHash,
          passwordHash,
          accountCreatedAt: new Date(),
        },
      ],
      { session },
    );
    return id.toString();
  });

  await AuditLogModel.create([
    {
      appId: tenant.id,
      aggregateType: 'CUSTOMER',
      aggregateId: customerId,
      action: 'CUSTOMER_REGISTERED',
      actorType: 'CUSTOMER',
      actorId: customerId,
    },
  ]);

  const customer = await CustomerModel.findById(customerId).lean();
  return { ...customerToken(tenant, customerId), customer: profileOf(customer as { dataEncrypted: string }) };
}

export async function loginCustomer(
  tenant: AppTenant,
  input: { email: string; password: string },
): Promise<{ accessToken: string; expiresIn: number; customer: CustomerProfile }> {
  const emailLookupHash = keyedLookupHash(input.email.toLowerCase(), env.encryptionKey);
  const customer = await CustomerModel.findOne({ appId: tenant.id, emailLookupHash }).lean();
  if (!customer?.passwordHash || !(await verifyPassword(input.password, customer.passwordHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  return {
    ...customerToken(tenant, customer._id.toString()),
    customer: profileOf(customer as { dataEncrypted: string }),
  };
}

export async function getCustomerProfile(tenant: AppTenant, customerId: string): Promise<CustomerProfile> {
  const customer = await CustomerModel.findOne({ _id: customerId, appId: tenant.id }).lean();
  if (!customer) throw notFound('Customer');
  return profileOf(customer as { dataEncrypted: string });
}

export type CustomerBooking = {
  id: string;
  status: 'HOLD' | 'BOOKED' | 'CANCELLED' | 'EXPIRED';
  startsAt: string;
  endsAt: string;
  localStart: string | null;
  timezone: string;
  canCancel: boolean;
  canReschedule: boolean;
  service: { id: string; name: string; priceCents: number; currency: string } | null;
  staff: { id: string; name: string } | null;
};

/** Every booking held against this customer, newest appointment first. */
export async function listCustomerBookings(
  tenant: AppTenant,
  customerId: string,
  options: { includePast?: boolean } = {},
): Promise<CustomerBooking[]> {
  const bookings = await AppointmentModel.find({
    appId: tenant.id,
    customerId,
    status: { $in: ['BOOKED', 'CANCELLED'] },
    ...(options.includePast ? {} : { startsAt: { $gte: new Date() } }),
  })
    .sort({ startsAt: -1 })
    .limit(200)
    .lean();

  const serviceIds = [...new Set(bookings.map((booking) => booking.serviceId.toString()))];
  const staffIds = [...new Set(bookings.map((booking) => booking.staffId.toString()))];
  const [services, staff] = await Promise.all([
    ServiceModel.find({ _id: { $in: serviceIds } }).lean(),
    StaffModel.find({ _id: { $in: staffIds } }).lean(),
  ]);
  const serviceById = new Map(services.map((row) => [row._id.toString(), row]));
  const staffById = new Map(staff.map((row) => [row._id.toString(), row]));
  const cutoffMs = tenant.rescheduleCutoffHours * 60 * 60_000;

  return bookings.map((booking) => {
    const service = serviceById.get(booking.serviceId.toString());
    const member = staffById.get(booking.staffId.toString());
    const startsAt = new Date(booking.startsAt);
    const isActive = booking.status === 'BOOKED' && startsAt.getTime() > Date.now();
    return {
      id: booking._id.toString(),
      status: booking.status as CustomerBooking['status'],
      startsAt: startsAt.toISOString(),
      endsAt: new Date(booking.endsAt).toISOString(),
      localStart: DateTime.fromJSDate(startsAt).setZone(tenant.timezone).toISO(),
      timezone: tenant.timezone,
      canCancel: isActive,
      canReschedule: isActive && startsAt.getTime() - Date.now() >= cutoffMs,
      service: service
        ? {
            id: service._id.toString(),
            name: service.name,
            priceCents: service.priceCents,
            currency: service.currency,
          }
        : null,
      staff: member ? { id: member._id.toString(), name: member.name } : null,
    };
  });
}

/** Throws unless the booking belongs to this customer. */
export async function assertBookingOwnedByCustomer(
  tenant: AppTenant,
  bookingId: string,
  customerId: string,
): Promise<void> {
  const owned = await AppointmentModel.exists({ _id: bookingId, appId: tenant.id, customerId });
  if (!owned) throw new HttpError(403, 'BOOKING_ACCESS_DENIED', 'The token cannot manage this booking');
}
