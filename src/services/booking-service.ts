import { DateTime } from 'luxon';
import type { ClientSession } from 'mongoose';
import { env } from '../config.js';
import { withMongoTransaction } from '../db.js';
import { minuteClaimTimes } from '../domain/claims.js';
import { decryptJson, encryptJson, keyedLookupHash, randomOtp, safeEqualHex, sha256 } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { signToken } from '../lib/jwt.js';
import {
  AppointmentModel,
  AuditLogModel,
  BookingOtpModel,
  CustomerModel,
  OutboxModel,
  ServiceModel,
  SlotClaimModel,
  StaffModel,
  Types,
  WaitlistModel,
} from '../models.js';
import { invalidateAvailability, withDistributedLock } from '../redis.js';
import type { AppTenant, AuthPrincipal } from '../types.js';
import { getAvailability } from './availability-service.js';

export type GuestDetails = { name?: string; phone?: string; socialHandle?: string };

type AppointmentShape = {
  _id: InstanceType<typeof Types.ObjectId>;
  appId: InstanceType<typeof Types.ObjectId>;
  staffId: InstanceType<typeof Types.ObjectId>;
  serviceId: InstanceType<typeof Types.ObjectId>;
  customerId?: InstanceType<typeof Types.ObjectId> | null;
  status: 'HOLD' | 'BOOKED' | 'CANCELLED' | 'EXPIRED';
  startsAt: Date;
  serviceEndsAt: Date;
  endsAt: Date;
  holdExpiresAt?: Date | null;
  customerDataEncrypted?: string | null;
  idempotencyKey?: string | null;
  paymentReference?: string | null;
  cancellationReason?: string | null;
};

export type BookingView = {
  id: string;
  status: AppointmentShape['status'];
  staffId: string;
  serviceId: string;
  startsAt: string;
  serviceEndsAt: string;
  endsAt: string;
  holdExpiresAt: string | null;
  paymentReference: string | null;
};

function view(row: AppointmentShape): BookingView {
  return {
    id: row._id.toString(),
    status: row.status,
    staffId: row.staffId.toString(),
    serviceId: row.serviceId.toString(),
    startsAt: new Date(row.startsAt).toISOString(),
    serviceEndsAt: new Date(row.serviceEndsAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
    holdExpiresAt: row.holdExpiresAt ? new Date(row.holdExpiresAt).toISOString() : null,
    paymentReference: row.paymentReference ?? null,
  };
}

function parseStart(value: string): DateTime {
  const start = DateTime.fromISO(value, { setZone: true });
  if (!start.isValid || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new HttpError(400, 'INVALID_START_TIME', 'The start time must include a UTC offset');
  }
  if (start.second !== 0 || start.millisecond !== 0) {
    throw new HttpError(400, 'START_NOT_MINUTE_ALIGNED', 'The start time must be aligned to a whole minute');
  }
  return start.toUTC();
}

export async function claimRange(
  session: ClientSession,
  input: {
    appId: string;
    staffId: string;
    sourceId: InstanceType<typeof Types.ObjectId>;
    sourceType: 'APPOINTMENT' | 'BLOCK';
    startsAt: Date;
    endsAt: Date;
    expiresAt?: Date | null;
  },
): Promise<void> {
  const claims = minuteClaimTimes(input.startsAt, input.endsAt).map((minute) => ({
    appId: input.appId,
    staffId: input.staffId,
    minute,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    expiresAt: input.expiresAt ?? null,
  }));
  if (claims.length) await SlotClaimModel.insertMany(claims, { session, ordered: true });
}

async function audit(
  session: ClientSession,
  input: {
    tenantId: string;
    appointmentId: string | InstanceType<typeof Types.ObjectId>;
    action: string;
    actorType: 'APP' | 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
    actorId?: string;
    oldValue?: object;
    newValue?: object;
  },
): Promise<void> {
  await AuditLogModel.create(
    [
      {
        appId: input.tenantId,
        aggregateType: 'APPOINTMENT',
        aggregateId: input.appointmentId,
        action: input.action,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
      },
    ],
    { session },
  );
}

async function enqueue(
  session: ClientSession,
  tenantId: string,
  eventType: string,
  appointmentId: string | InstanceType<typeof Types.ObjectId>,
  availableAt = new Date(),
  payload: object = {},
  secretPayloadEncrypted?: string,
): Promise<void> {
  await OutboxModel.create(
    [
      {
        appId: tenantId,
        eventType,
        aggregateId: appointmentId,
        payload: { appointmentId: appointmentId.toString(), ...payload },
        secretPayloadEncrypted: secretPayloadEncrypted ?? null,
        availableAt,
      },
    ],
    { session },
  );
}

async function enqueueReminders(
  session: ClientSession,
  tenantId: string,
  appointmentId: string | InstanceType<typeof Types.ObjectId>,
  startsAt: Date,
): Promise<void> {
  const now = Date.now();
  const reminder24h = startsAt.getTime() - 24 * 60 * 60_000;
  const reminder2h = startsAt.getTime() - 2 * 60 * 60_000;
  if (reminder24h > now) await enqueue(session, tenantId, 'REMINDER_24H', appointmentId, new Date(reminder24h));
  if (reminder2h > now) await enqueue(session, tenantId, 'REMINDER_2H', appointmentId, new Date(reminder2h));
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000;
}

function isSameHoldRequest(
  appointment: AppointmentShape,
  input: { staffId: string; serviceId: string; startMs: number },
): boolean {
  return (
    appointment.staffId.toString() === input.staffId &&
    appointment.serviceId.toString() === input.serviceId &&
    new Date(appointment.startsAt).getTime() === input.startMs
  );
}

export async function createHold(
  tenant: AppTenant,
  input: {
    staffId: string;
    serviceId: string;
    slotStartTime: string;
    customer: GuestDetails;
    idempotencyKey: string;
  },
): Promise<BookingView> {
  const start = parseStart(input.slotStartTime);
  const date = start.setZone(tenant.timezone).toISODate()!;
  const existing = (await AppointmentModel.findOne({ appId: tenant.id, idempotencyKey: input.idempotencyKey }).lean()) as
    | AppointmentShape
    | null;
  if (existing) {
    if (!isSameHoldRequest(existing, { staffId: input.staffId, serviceId: input.serviceId, startMs: start.toMillis() })) {
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different hold');
    }
    return view(existing);
  }

  try {
    const booking = await withDistributedLock(`schedule:${tenant.id}:${input.staffId}:${date}`, () =>
      withMongoTransaction(async (session) => {
        const repeated = (await AppointmentModel.findOne({
          appId: tenant.id,
          idempotencyKey: input.idempotencyKey,
        })
          .session(session)
          .lean()) as AppointmentShape | null;
        if (repeated) {
          if (!isSameHoldRequest(repeated, { staffId: input.staffId, serviceId: input.serviceId, startMs: start.toMillis() })) {
            throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different hold');
          }
          return repeated;
        }
        const now = new Date();
        await SlotClaimModel.deleteMany({ appId: tenant.id, staffId: input.staffId, expiresAt: { $lte: now } }).session(
          session,
        );
        await AppointmentModel.updateMany(
          { appId: tenant.id, staffId: input.staffId, status: 'HOLD', holdExpiresAt: { $lte: now } },
          { $set: { status: 'EXPIRED' } },
          { session },
        );
        const availability = await getAvailability(
          tenant,
          { staffId: input.staffId, serviceId: input.serviceId, date },
          session,
        );
        const selected = availability.slots.find((slot) => Date.parse(slot.start) === start.toMillis());
        if (!selected) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That time is not available for this service');

        const appointmentId = new Types.ObjectId();
        const holdExpiresAt = new Date(Date.now() + tenant.holdTtlMinutes * 60_000);
        const appointmentData = {
          _id: appointmentId,
          appId: tenant.id,
          staffId: input.staffId,
          serviceId: input.serviceId,
          status: 'HOLD' as const,
          startsAt: new Date(selected.start),
          serviceEndsAt: new Date(selected.serviceEnd),
          endsAt: new Date(selected.endWithBuffer),
          holdExpiresAt,
          customerDataEncrypted: encryptJson(input.customer, env.encryptionKey),
          idempotencyKey: input.idempotencyKey,
        };
        await AppointmentModel.create([appointmentData], { session });
        await claimRange(session, {
          appId: tenant.id,
          staffId: input.staffId,
          sourceId: appointmentId,
          sourceType: 'APPOINTMENT',
          startsAt: appointmentData.startsAt,
          endsAt: appointmentData.endsAt,
          expiresAt: holdExpiresAt,
        });
        await audit(session, {
          tenantId: tenant.id,
          appointmentId,
          action: 'HOLD_CREATED',
          actorType: 'APP',
          newValue: { status: 'HOLD', startsAt: appointmentData.startsAt.toISOString() },
        });
        return { ...appointmentData, appId: new Types.ObjectId(tenant.id), staffId: new Types.ObjectId(input.staffId), serviceId: new Types.ObjectId(input.serviceId) } as AppointmentShape;
      }),
    );
    await invalidateAvailability(tenant.id, input.staffId, date);
    return view(booking);
  } catch (error) {
    if (isDuplicateKey(error)) {
      const repeated = (await AppointmentModel.findOne({
        appId: tenant.id,
        idempotencyKey: input.idempotencyKey,
      }).lean()) as AppointmentShape | null;
      if (repeated) {
        if (!isSameHoldRequest(repeated, { staffId: input.staffId, serviceId: input.serviceId, startMs: start.toMillis() })) {
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different hold');
        }
        return view(repeated);
      }
      throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That time is no longer available');
    }
    throw error;
  }
}

export async function confirmHold(
  tenant: AppTenant,
  input: { holdId: string; paymentReference?: string },
): Promise<BookingView> {
  const result = await withMongoTransaction(async (session) => {
    const hold = (await AppointmentModel.findOne({ _id: input.holdId, appId: tenant.id }).session(session).lean()) as
      | AppointmentShape
      | null;
    if (!hold) throw notFound('Hold');
    if (hold.status === 'BOOKED') return { booking: hold };
    if (hold.status !== 'HOLD' || !hold.holdExpiresAt || new Date(hold.holdExpiresAt).getTime() <= Date.now()) {
      if (hold.status === 'HOLD') {
        await AppointmentModel.updateOne({ _id: hold._id }, { $set: { status: 'EXPIRED' } }, { session });
        await SlotClaimModel.deleteMany({ sourceId: hold._id }).session(session);
        await audit(session, {
          tenantId: tenant.id,
          appointmentId: hold._id,
          action: 'HOLD_EXPIRED',
          actorType: 'SYSTEM',
          oldValue: { status: 'HOLD' },
          newValue: { status: 'EXPIRED' },
        });
      }
      return { expired: true as const };
    }

    const guest = decryptJson<GuestDetails>(hold.customerDataEncrypted ?? '', env.encryptionKey);
    const phoneHash = guest.phone ? keyedLookupHash(guest.phone, env.encryptionKey) : null;
    const existingCustomer = phoneHash
      ? ((await CustomerModel.findOne({ appId: tenant.id, phoneLookupHash: phoneHash }).session(session).lean()) as {
          _id: InstanceType<typeof Types.ObjectId>;
        } | null)
      : null;
    let customerId = existingCustomer?._id;
    if (!customerId) {
      customerId = new Types.ObjectId();
      await CustomerModel.create(
        [{ _id: customerId, appId: tenant.id, dataEncrypted: encryptJson(guest, env.encryptionKey), phoneLookupHash: phoneHash }],
        { session },
      );
    }
    await AppointmentModel.updateOne(
      { _id: hold._id },
      {
        $set: {
          status: 'BOOKED',
          customerId,
          paymentReference: input.paymentReference ?? null,
          holdExpiresAt: null,
          customerDataEncrypted: null,
        },
      },
      { session },
    );
    await SlotClaimModel.updateMany({ sourceId: hold._id }, { $unset: { expiresAt: 1 } }, { session });
    await enqueue(session, tenant.id, 'BOOKING_CREATED', hold._id);
    await enqueueReminders(session, tenant.id, hold._id, new Date(hold.startsAt));
    await audit(session, {
      tenantId: tenant.id,
      appointmentId: hold._id,
      action: 'BOOKING_CONFIRMED',
      actorType: 'APP',
      oldValue: { status: 'HOLD' },
      newValue: { status: 'BOOKED', customerId: customerId.toString() },
    });
    return {
      booking: { ...hold, status: 'BOOKED' as const, customerId, holdExpiresAt: null, customerDataEncrypted: null, paymentReference: input.paymentReference ?? null },
    };
  });
  if ('expired' in result) throw new HttpError(410, 'HOLD_EXPIRED', 'The hold has expired');
  return view(result.booking);
}

export async function getBooking(tenant: AppTenant, bookingId: string): Promise<object> {
  const appointment = (await AppointmentModel.findOne({ _id: bookingId, appId: tenant.id }).lean()) as
    | AppointmentShape
    | null;
  if (!appointment) throw notFound('Booking');
  const [service, staff, customer] = await Promise.all([
    ServiceModel.findById(appointment.serviceId).lean(),
    StaffModel.findById(appointment.staffId).lean(),
    appointment.customerId ? CustomerModel.findById(appointment.customerId).lean() : null,
  ]);
  const customerData = customer && 'dataEncrypted' in customer
    ? decryptJson<GuestDetails>(String(customer.dataEncrypted), env.encryptionKey)
    : appointment.customerDataEncrypted
      ? decryptJson<GuestDetails>(appointment.customerDataEncrypted, env.encryptionKey)
      : null;
  return {
    ...view(appointment),
    service: service
      ? { id: service._id.toString(), name: service.name, priceCents: service.priceCents, currency: service.currency }
      : null,
    staff: staff ? { id: staff._id.toString(), name: staff.name } : null,
    customer: customerData,
    timezone: tenant.timezone,
    localStart: DateTime.fromJSDate(new Date(appointment.startsAt)).setZone(tenant.timezone).toISO(),
    address: tenant.address,
  };
}

export async function cancelBooking(
  tenant: AppTenant,
  bookingId: string,
  principal: AuthPrincipal,
  reason?: string,
): Promise<BookingView> {
  const booking = await withMongoTransaction(async (session) => {
    const current = (await AppointmentModel.findOne({ _id: bookingId, appId: tenant.id }).session(session).lean()) as
      | AppointmentShape
      | null;
    if (!current) throw notFound('Booking');
    if (current.status === 'CANCELLED') return current;
    if (!['BOOKED', 'HOLD'].includes(current.status)) {
      throw new HttpError(409, 'BOOKING_NOT_ACTIVE', 'Only an active booking can be cancelled');
    }
    await AppointmentModel.updateOne(
      { _id: current._id },
      {
        $set: {
          status: 'CANCELLED',
          cancellationReason: reason ?? null,
          cancelledAt: new Date(),
          holdExpiresAt: null,
        },
      },
      { session },
    );
    await SlotClaimModel.deleteMany({ sourceId: current._id }).session(session);
    await OutboxModel.updateMany(
      { aggregateId: current._id, eventType: { $in: ['REMINDER_24H', 'REMINDER_2H'] }, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } },
      { session },
    );
    await enqueue(session, tenant.id, 'BOOKING_CANCELLED', current._id);
    const requestedDate = DateTime.fromJSDate(new Date(current.startsAt)).setZone(tenant.timezone).toISODate();
    const waiters = await WaitlistModel.find({
      appId: tenant.id,
      staffId: current.staffId,
      requestedDate,
      status: 'WAITING',
    })
      .session(session)
      .lean();
    if (waiters.length) {
      await WaitlistModel.updateMany(
        { _id: { $in: waiters.map((waiter) => waiter._id) } },
        { $set: { status: 'NOTIFIED', notifiedAt: new Date() } },
        { session },
      );
      for (const waiter of waiters) {
        await enqueue(session, tenant.id, 'WAITLIST_SPOT_OPEN', current._id, new Date(), {
          waitlistId: waiter._id.toString(),
        });
      }
    }
    await audit(session, {
      tenantId: tenant.id,
      appointmentId: current._id,
      action: 'BOOKING_CANCELLED',
      actorType: principal.type,
      actorId: principal.id,
      oldValue: { status: current.status },
      newValue: { status: 'CANCELLED' },
    });
    return { ...current, status: 'CANCELLED' as const, holdExpiresAt: null, cancellationReason: reason ?? null };
  });
  const date = DateTime.fromJSDate(new Date(booking.startsAt)).setZone(tenant.timezone).toISODate()!;
  await invalidateAvailability(tenant.id, booking.staffId.toString(), date);
  return view(booking);
}

export async function rescheduleBooking(
  tenant: AppTenant,
  bookingId: string,
  principal: AuthPrincipal,
  newSlotStartTime: string,
): Promise<BookingView> {
  const newStart = parseStart(newSlotStartTime);
  const newDate = newStart.setZone(tenant.timezone).toISODate()!;
  const original = (await AppointmentModel.findOne({ _id: bookingId, appId: tenant.id }).lean()) as AppointmentShape | null;
  if (!original) throw notFound('Booking');
  const oldDate = DateTime.fromJSDate(new Date(original.startsAt)).setZone(tenant.timezone).toISODate()!;

  try {
    const moved = await withDistributedLock(`schedule:${tenant.id}:${original.staffId}:${newDate}`, () =>
      withMongoTransaction(async (session) => {
        const booking = (await AppointmentModel.findOne({ _id: bookingId, appId: tenant.id }).session(session).lean()) as
          | AppointmentShape
          | null;
        if (!booking) throw notFound('Booking');
        if (booking.status !== 'BOOKED') {
          throw new HttpError(409, 'BOOKING_NOT_ACTIVE', 'Only a booked appointment can be rescheduled');
        }
        if (new Date(booking.startsAt).getTime() - Date.now() < tenant.rescheduleCutoffHours * 60 * 60_000) {
          throw new HttpError(
            409,
            'RESCHEDULE_WINDOW_CLOSED',
            `Bookings cannot be rescheduled within ${tenant.rescheduleCutoffHours} hours of the appointment`,
          );
        }
        if (new Date(booking.startsAt).getTime() === newStart.toMillis()) return booking;
        await SlotClaimModel.deleteMany({
          appId: tenant.id,
          staffId: booking.staffId,
          expiresAt: { $lte: new Date() },
        }).session(session);
        const availability = await getAvailability(
          tenant,
          {
            staffId: booking.staffId.toString(),
            serviceId: booking.serviceId.toString(),
            date: newDate,
            excludeAppointmentId: booking._id.toString(),
          },
          session,
        );
        const selected = availability.slots.find((slot) => Date.parse(slot.start) === newStart.toMillis());
        if (!selected) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'The new time is not available');
        await SlotClaimModel.deleteMany({ sourceId: booking._id }).session(session);
        await claimRange(session, {
          appId: tenant.id,
          staffId: booking.staffId.toString(),
          sourceId: booking._id,
          sourceType: 'APPOINTMENT',
          startsAt: new Date(selected.start),
          endsAt: new Date(selected.endWithBuffer),
        });
        await AppointmentModel.updateOne(
          { _id: booking._id },
          {
            $set: {
              startsAt: new Date(selected.start),
              serviceEndsAt: new Date(selected.serviceEnd),
              endsAt: new Date(selected.endWithBuffer),
            },
          },
          { session },
        );
        await OutboxModel.updateMany(
          { aggregateId: booking._id, eventType: { $in: ['REMINDER_24H', 'REMINDER_2H'] }, status: 'PENDING' },
          { $set: { status: 'CANCELLED' } },
          { session },
        );
        await enqueue(session, tenant.id, 'BOOKING_RESCHEDULED', booking._id, new Date(), {
          oldStartsAt: new Date(booking.startsAt).toISOString(),
          newStartsAt: selected.start,
        });
        await enqueueReminders(session, tenant.id, booking._id, new Date(selected.start));
        await audit(session, {
          tenantId: tenant.id,
          appointmentId: booking._id,
          action: 'BOOKING_RESCHEDULED',
          actorType: principal.type,
          actorId: principal.id,
          oldValue: { startsAt: new Date(booking.startsAt).toISOString(), endsAt: new Date(booking.endsAt).toISOString() },
          newValue: { startsAt: selected.start, endsAt: selected.endWithBuffer },
        });
        return {
          ...booking,
          startsAt: new Date(selected.start),
          serviceEndsAt: new Date(selected.serviceEnd),
          endsAt: new Date(selected.endWithBuffer),
        };
      }),
    );
    await Promise.all([
      invalidateAvailability(tenant.id, moved.staffId.toString(), oldDate),
      invalidateAvailability(tenant.id, moved.staffId.toString(), newDate),
    ]);
    return view(moved);
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'The new time is no longer available');
    throw error;
  }
}

export async function requestBookingOtp(
  tenant: AppTenant,
  bookingId: string,
): Promise<{ expiresAt: string; devCode?: string }> {
  const code = randomOtp();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await withMongoTransaction(async (session) => {
    const booking = await AppointmentModel.findOne({ _id: bookingId, appId: tenant.id, status: 'BOOKED' })
      .session(session)
      .lean();
    if (!booking) throw notFound('Booking');
    await BookingOtpModel.updateMany(
      { appointmentId: bookingId, consumedAt: null },
      { $set: { consumedAt: new Date() } },
      { session },
    );
    await BookingOtpModel.create(
      [{ appId: tenant.id, appointmentId: bookingId, codeHash: sha256(`${bookingId}:${code}`), expiresAt }],
      { session },
    );
    await enqueue(
      session,
      tenant.id,
      'BOOKING_OTP_REQUESTED',
      bookingId,
      new Date(),
      {},
      encryptJson({ code }, env.encryptionKey),
    );
  });
  return { expiresAt: expiresAt.toISOString(), ...(env.DEV_EXPOSE_OTP ? { devCode: code } : {}) };
}

export async function verifyBookingOtp(
  tenant: AppTenant,
  bookingId: string,
  code: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const customerId = await withMongoTransaction(async (session) => {
    const otp = await BookingOtpModel.findOne({
      appId: tenant.id,
      appointmentId: bookingId,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .session(session)
      .lean();
    if (!otp) throw new HttpError(400, 'OTP_EXPIRED', 'The verification code is invalid or expired');
    if (otp.attempts >= 5) throw new HttpError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many verification attempts');
    if (!safeEqualHex(sha256(`${bookingId}:${code}`), otp.codeHash)) {
      await BookingOtpModel.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } }, { session });
      return null;
    }
    await BookingOtpModel.updateOne({ _id: otp._id }, { $set: { consumedAt: new Date() } }, { session });
    const booking = await AppointmentModel.findById(bookingId).select({ customerId: 1 }).session(session).lean();
    return booking?.customerId?.toString() ?? bookingId;
  });
  if (!customerId) throw new HttpError(400, 'INVALID_OTP', 'The verification code is invalid or expired');
  const expiresIn = 15 * 60;
  return {
    accessToken: signToken({ aud: tenant.id, sub: customerId, type: 'CUSTOMER', appointmentId: bookingId }, expiresIn),
    expiresIn,
  };
}
