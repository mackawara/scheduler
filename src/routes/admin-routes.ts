import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { withMongoTransaction } from '../db.js';
import { verifyPassword } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { signToken } from '../lib/jwt.js';
import { adminAuth } from '../middleware/auth.js';
import {
  AdminUserModel,
  AppointmentModel,
  AppModel,
  AuditLogModel,
  BlockedSlotModel,
  ServiceModel,
  SlotClaimModel,
  StaffModel,
  Types,
} from '../models.js';
import { invalidateAvailability, withDistributedLock } from '../redis.js';
import { cancelBooking, claimRange, getBooking, rescheduleBooking } from '../services/booking-service.js';
import { searchSlots } from '../services/slot-search-service.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a MongoDB ObjectId');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

function localDatesTouched(startsAt: Date, endsAt: Date, timezone: string): string[] {
  const dates: string[] = [];
  let cursor = DateTime.fromJSDate(startsAt).setZone(timezone).startOf('day');
  const last = DateTime.fromMillis(endsAt.getTime() - 1).setZone(timezone).startOf('day');
  while (cursor.toMillis() <= last.toMillis()) {
    dates.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

export const adminAuthRoutes = Router();
adminAuthRoutes.post('/login', async (req, res) => {
  const body = z
    .object({ appSlug: z.string().trim().min(1), email: z.email(), password: z.string().min(8).max(200) })
    .parse(req.body);
  const app = await AppModel.findOne({ slug: body.appSlug.toLowerCase(), active: true }).lean();
  const user = app
    ? await AdminUserModel.findOne({ appId: app._id, email: body.email.toLowerCase(), active: true }).lean()
    : null;
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  const expiresIn = 8 * 60 * 60;
  res.json({
    data: {
      accessToken: signToken(
        { aud: app!._id.toString(), sub: user._id.toString(), type: 'ADMIN', role: user.role },
        expiresIn,
      ),
      expiresIn,
    },
  });
});

export const adminRoutes = Router();
adminRoutes.use(adminAuth);

adminRoutes.post('/services', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      baseDurationMinutes: z.number().int().positive().max(1440),
      bufferDurationMinutes: z.number().int().nonnegative().max(240).default(0),
      resourceType: z.string().trim().min(1).max(80),
      priceCents: z.number().int().nonnegative().default(0),
      currency: z.string().length(3).transform((value) => value.toUpperCase()).default('USD'),
    })
    .parse(req.body);
  const id = await withMongoTransaction(async (session) => {
    const [service] = await ServiceModel.create([{ appId: req.tenant!.id, ...body }], { session });
    if (!service) throw new HttpError(500, 'SERVICE_CREATE_FAILED', 'Could not create the service');
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'SERVICE',
          aggregateId: service._id,
          action: 'SERVICE_CREATED',
          actorType: 'ADMIN',
          actorId: req.principal!.id,
          newValue: body,
        },
      ],
      { session },
    );
    return service._id.toString();
  });
  res.status(201).json({ data: { id } });
});

adminRoutes.post('/staff', async (req, res) => {
  const body = z
    .object({ name: z.string().trim().min(1).max(120), resourceType: z.string().trim().min(1).max(80) })
    .parse(req.body);
  const id = await withMongoTransaction(async (session) => {
    const [staff] = await StaffModel.create([{ appId: req.tenant!.id, ...body }], { session });
    if (!staff) throw new HttpError(500, 'STAFF_CREATE_FAILED', 'Could not create the staff member');
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'STAFF',
          aggregateId: staff._id,
          action: 'STAFF_CREATED',
          actorType: 'ADMIN',
          actorId: req.principal!.id,
          newValue: body,
        },
      ],
      { session },
    );
    return staff._id.toString();
  });
  res.status(201).json({ data: { id } });
});

adminRoutes.put('/staff/:id/working-hours', async (req, res) => {
  const staffId = objectId.parse(req.params.id);
  const body = z
    .object({
      hours: z
        .array(
          z
            .object({ dayOfWeek: z.number().int().min(0).max(6), startsAt: time, endsAt: time })
            .refine((value) => value.startsAt < value.endsAt, { message: 'startsAt must be before endsAt' }),
        )
        .max(28),
    })
    .refine(
      ({ hours }) =>
        hours.every((current, index) =>
          hours.every(
            (other, otherIndex) =>
              index === otherIndex ||
              current.dayOfWeek !== other.dayOfWeek ||
              current.endsAt <= other.startsAt ||
              current.startsAt >= other.endsAt,
          ),
        ),
      { message: 'Working-hour ranges cannot overlap' },
    )
    .parse(req.body);
  await withMongoTransaction(async (session) => {
    const staff = await StaffModel.findOneAndUpdate(
      { _id: staffId, appId: req.tenant!.id },
      { $set: { workingHours: body.hours } },
      { returnDocument: 'after', session },
    );
    if (!staff) throw notFound('Staff member');
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'STAFF',
          aggregateId: staffId,
          action: 'WORKING_HOURS_REPLACED',
          actorType: 'ADMIN',
          actorId: req.principal!.id,
          newValue: body,
        },
      ],
      { session },
    );
  });
  await invalidateAvailability(req.tenant!.id, staffId);
  res.json({ data: { staffId, hours: body.hours } });
});

adminRoutes.post('/block-slot', async (req, res) => {
  const body = z
    .object({
      staffId: objectId,
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
      reason: z.string().trim().max(300).optional(),
    })
    .refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), {
      message: 'startsAt must be before endsAt',
    })
    .refine(
      (value) =>
        new Date(value.startsAt).getUTCSeconds() === 0 &&
        new Date(value.startsAt).getUTCMilliseconds() === 0 &&
        new Date(value.endsAt).getUTCSeconds() === 0 &&
        new Date(value.endsAt).getUTCMilliseconds() === 0,
      { message: 'Blocked times must align to whole minutes' },
    )
    .parse(req.body);
  const localDate = DateTime.fromISO(body.startsAt, { setZone: true }).setZone(req.tenant!.timezone).toISODate()!;
  try {
    const id = await withDistributedLock(`schedule:${req.tenant!.id}:${body.staffId}:${localDate}`, () =>
      withMongoTransaction(async (session) => {
        const staff = await StaffModel.exists({ _id: body.staffId, appId: req.tenant!.id, active: true }).session(session);
        if (!staff) throw notFound('Staff member');
        await SlotClaimModel.deleteMany({
          appId: req.tenant!.id,
          staffId: body.staffId,
          expiresAt: { $lte: new Date() },
        }).session(session);
        const blockId = new Types.ObjectId();
        await BlockedSlotModel.create(
          [
            {
              _id: blockId,
              appId: req.tenant!.id,
              staffId: body.staffId,
              startsAt: new Date(body.startsAt),
              endsAt: new Date(body.endsAt),
              reason: body.reason ?? null,
              createdBy: req.principal!.id,
            },
          ],
          { session },
        );
        await claimRange(session, {
          appId: req.tenant!.id,
          staffId: body.staffId,
          sourceId: blockId,
          sourceType: 'BLOCK',
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
        });
        await AuditLogModel.create(
          [
            {
              appId: req.tenant!.id,
              aggregateType: 'BLOCKED_SLOT',
              aggregateId: blockId,
              action: 'BLOCK_CREATED',
              actorType: 'ADMIN',
              actorId: req.principal!.id,
              newValue: body,
            },
          ],
          { session },
        );
        return blockId.toString();
      }),
    );
    await Promise.all(
      localDatesTouched(new Date(body.startsAt), new Date(body.endsAt), req.tenant!.timezone).map((date) =>
        invalidateAvailability(req.tenant!.id, body.staffId, date),
      ),
    );
    res.status(201).json({ data: { id } });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000) {
      throw new HttpError(409, 'BLOCK_CONFLICTS_WITH_BOOKING', 'The blocked time overlaps a booking, hold, or another block');
    }
    throw error;
  }
});

adminRoutes.delete('/block-slot/:id', async (req, res) => {
  const blockId = objectId.parse(req.params.id);
  const block = await withMongoTransaction(async (session) => {
    const found = await BlockedSlotModel.findOne({ _id: blockId, appId: req.tenant!.id }).session(session).lean();
    if (!found) throw notFound('Blocked slot');
    await BlockedSlotModel.deleteOne({ _id: blockId }, { session });
    await SlotClaimModel.deleteMany({ sourceId: blockId }).session(session);
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'BLOCKED_SLOT',
          aggregateId: blockId,
          action: 'BLOCK_REMOVED',
          actorType: 'ADMIN',
          actorId: req.principal!.id,
          oldValue: { startsAt: found.startsAt, endsAt: found.endsAt, staffId: found.staffId },
        },
      ],
      { session },
    );
    return found;
  });
  await Promise.all(
    localDatesTouched(block.startsAt, block.endsAt, req.tenant!.timezone).map((date) =>
      invalidateAvailability(req.tenant!.id, block.staffId.toString(), date),
    ),
  );
  res.status(204).send();
});

adminRoutes.get('/bookings', async (req, res) => {
  const query = z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      status: z.enum(['HOLD', 'BOOKED', 'CANCELLED', 'EXPIRED']).optional(),
    })
    .refine((value) => Date.parse(value.from) < Date.parse(value.to), { message: 'from must be before to' })
    .parse(req.query);
  const bookings = await AppointmentModel.find({
    appId: req.tenant!.id,
    startsAt: { $gte: new Date(query.from), $lt: new Date(query.to) },
    ...(query.status ? { status: query.status } : {}),
  })
    .sort({ startsAt: 1 })
    .populate('serviceId', 'name')
    .populate('staffId', 'name')
    .lean();
  res.json({
    data: bookings.map((booking) => ({
      id: booking._id.toString(),
      status: booking.status,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      serviceName:
        typeof booking.serviceId === 'object' && booking.serviceId && 'name' in booking.serviceId
          ? booking.serviceId.name
          : null,
      staffName:
        typeof booking.staffId === 'object' && booking.staffId && 'name' in booking.staffId
          ? booking.staffId.name
          : null,
      localStart: DateTime.fromJSDate(booking.startsAt).setZone(req.tenant!.timezone).toISO(),
    })),
  });
});

adminRoutes.get('/services', async (req, res) => {
  const services = await ServiceModel.find({ appId: req.tenant!.id }).sort({ name: 1 }).lean();
  res.json({
    data: services.map((service) => ({
      id: service._id.toString(),
      name: service.name,
      description: service.description,
      baseDurationMinutes: service.baseDurationMinutes,
      bufferDurationMinutes: service.bufferDurationMinutes,
      resourceType: service.resourceType,
      priceCents: service.priceCents,
      currency: service.currency,
      active: service.active,
    })),
  });
});

adminRoutes.get('/staff', async (req, res) => {
  const staff = await StaffModel.find({ appId: req.tenant!.id }).sort({ name: 1 }).lean();
  res.json({
    data: staff.map((member) => ({
      id: member._id.toString(),
      name: member.name,
      resourceType: member.resourceType,
      workingHours: member.workingHours,
      active: member.active,
    })),
  });
});

adminRoutes.get('/bookings/:id', async (req, res) => {
  res.json({ data: await getBooking(req.tenant!, objectId.parse(req.params.id)) });
});

/** Times the booking could move to on a given day, for the reschedule picker. */
adminRoutes.get('/bookings/:id/reschedule-options', async (req, res) => {
  const bookingId = objectId.parse(req.params.id);
  const query = z.object({ date: z.iso.date() }).parse(req.query);
  const booking = await AppointmentModel.findOne({ _id: bookingId, appId: req.tenant!.id }).lean();
  if (!booking) throw notFound('Booking');
  const search = await searchSlots(req.tenant!, {
    serviceId: booking.serviceId.toString(),
    date: query.date,
    staffId: booking.staffId.toString(),
  });
  res.json({ data: search });
});

adminRoutes.post('/bookings/:id/cancel', async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body);
  res.json({
    data: await cancelBooking(req.tenant!, objectId.parse(req.params.id), req.principal!, body.reason),
  });
});

adminRoutes.patch('/bookings/:id/reschedule', async (req, res) => {
  const body = z.object({ newSlotStartTime: z.iso.datetime({ offset: true }) }).parse(req.body);
  res.json({
    data: await rescheduleBooking(
      req.tenant!,
      objectId.parse(req.params.id),
      req.principal!,
      body.newSlotStartTime,
    ),
  });
});
