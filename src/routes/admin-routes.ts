import { Router, type RequestHandler } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { withMongoTransaction } from '../db.js';
import { decryptJson, verifyPassword } from '../lib/crypto.js';
import { HttpError, notFound, serviceConflict } from '../lib/errors.js';
import { signToken } from '../lib/jwt.js';
import { adminServiceView, adminStaffView } from '../lib/views.js';
import { adminAuth } from '../middleware/auth.js';
import {
  AdminUserModel,
  AppointmentModel,
  AppModel,
  AuditLogModel,
  BlockedSlotModel,
  CustomerModel,
  ServiceModel,
  SlotClaimModel,
  StaffModel,
  Types,
} from '../models.js';
import { invalidateAvailability, withDistributedLock } from '../redis.js';
import {
  cancelBooking,
  claimRange,
  rescheduleBooking,
  type GuestDetails,
} from '../services/booking-service.js';
import { env } from '../config.js';
import { getAvailability, parseLocalDate, workingWindows } from '../services/availability-service.js';
import { buildScheduleGrid } from '../domain/schedule.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a MongoDB ObjectId');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

function blockView(block: {
  _id: { toString(): string };
  staffId: { toString(): string };
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}) {
  return {
    id: block._id.toString(),
    staffId: block.staffId.toString(),
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
    reason: block.reason ?? null,
  };
}

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

/** Catalog and staff changes are limited to ADMIN users; STAFF users get read-only access. */
const requireAdminRole: RequestHandler = (req, _res, next) => {
  if (req.principal?.type === 'ADMIN' && req.principal.role === 'ADMIN') return next();
  next(new HttpError(403, 'ADMIN_ROLE_REQUIRED', 'Only ADMIN users can make this change'));
};

const serviceFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  baseDurationMinutes: z.number().int().positive().max(1440),
  bufferDurationMinutes: z.number().int().nonnegative().max(240),
  resourceType: z.string().trim().min(1).max(80),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  catalogRetailerId: z.string().trim().min(1).max(200).nullable(),
};
const SLOT_AFFECTING_SERVICE_FIELDS = ['baseDurationMinutes', 'bufferDurationMinutes', 'resourceType', 'active'];

async function invalidateAllStaff(appId: string): Promise<void> {
  const staff = await StaffModel.find({ appId }).select({ _id: 1 }).lean();
  await Promise.all(staff.map((member) => invalidateAvailability(appId, member._id.toString())));
}

adminRoutes.get('/services', async (req, res) => {
  const query = z.object({ includeInactive: z.enum(['true', 'false']).default('false') }).parse(req.query);
  const services = await ServiceModel.find({
    appId: req.tenant!.id,
    ...(query.includeInactive === 'true' ? {} : { active: true }),
  })
    .sort({ name: 1 })
    .lean();
  res.json({ data: services.map(adminServiceView) });
});

adminRoutes.patch('/services/:id', requireAdminRole, async (req, res) => {
  const serviceId = objectId.parse(req.params.id);
  const body = z
    .strictObject({ ...serviceFields, description: serviceFields.description.nullable(), active: z.boolean() })
    .partial()
    .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' })
    .parse(req.body);
  const updated = await withMongoTransaction(async (session) => {
    const before = await ServiceModel.findOne({ _id: serviceId, appId: req.tenant!.id }).session(session).lean();
    if (!before) throw notFound('Service');
    const after = await ServiceModel.findOneAndUpdate(
      { _id: serviceId, appId: req.tenant!.id },
      { $set: body },
      { returnDocument: 'after', session, runValidators: true },
    ).lean();
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'SERVICE',
          aggregateId: serviceId,
          action: 'SERVICE_UPDATED',
          actorType: 'ADMIN',
          actorId: req.principal!.id,
          oldValue: Object.fromEntries(Object.keys(body).map((key) => [key, before[key as keyof typeof before] ?? null])),
          newValue: body,
        },
      ],
      { session },
    );
    return after!;
  }).catch((error: unknown) => {
    throw serviceConflict(error) ?? error;
  });
  if (Object.keys(body).some((key) => SLOT_AFFECTING_SERVICE_FIELDS.includes(key))) {
    await invalidateAllStaff(req.tenant!.id);
  }
  res.json({ data: adminServiceView(updated) });
});

adminRoutes.post('/services', requireAdminRole, async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      baseDurationMinutes: z.number().int().positive().max(1440),
      bufferDurationMinutes: z.number().int().nonnegative().max(240).default(0),
      resourceType: z.string().trim().min(1).max(80),
      priceCents: z.number().int().nonnegative().default(0),
      currency: z.string().length(3).transform((value) => value.toUpperCase()).default('USD'),
      catalogRetailerId: z.string().trim().min(1).max(200).nullable().optional(),
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
  }).catch((error: unknown) => {
    throw serviceConflict(error) ?? error;
  });
  res.status(201).json({ data: { id } });
});

adminRoutes.post('/staff', requireAdminRole, async (req, res) => {
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
  }).catch((error: unknown) => {
    throw serviceConflict(error) ?? error;
  });
  res.status(201).json({ data: { id } });
});

adminRoutes.get('/staff', async (req, res) => {
  const query = z.object({ includeInactive: z.enum(['true', 'false']).default('false') }).parse(req.query);
  const staff = await StaffModel.find({
    appId: req.tenant!.id,
    ...(query.includeInactive === 'true' ? {} : { active: true }),
  })
    .sort({ name: 1 })
    .lean();
  res.json({ data: staff.map((member) => adminStaffView(member, true)) });
});

adminRoutes.get('/staff/:id', async (req, res) => {
  const staffId = objectId.parse(req.params.id);
  const staff = await StaffModel.findOne({ _id: staffId, appId: req.tenant!.id }).lean();
  if (!staff) throw notFound('Staff member');
  res.json({ data: adminStaffView(staff, true) });
});

adminRoutes.patch('/staff/:id', requireAdminRole, async (req, res) => {
  const staffId = objectId.parse(req.params.id);
  const body = z
    .strictObject({
      name: z.string().trim().min(1).max(120),
      resourceType: z.string().trim().min(1).max(80),
      active: z.boolean(),
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' })
    .parse(req.body);
  const updated = await withMongoTransaction(async (session) => {
    const before = await StaffModel.findOne({ _id: staffId, appId: req.tenant!.id }).session(session).lean();
    if (!before) throw notFound('Staff member');
    const after = await StaffModel.findOneAndUpdate(
      { _id: staffId, appId: req.tenant!.id },
      { $set: body },
      { returnDocument: 'after', session, runValidators: true },
    ).lean();
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'STAFF',
          aggregateId: staffId,
          action: 'STAFF_UPDATED',
          actorType: 'ADMIN',
          actorId: req.principal!.id,
          oldValue: Object.fromEntries(Object.keys(body).map((key) => [key, before[key as keyof typeof before] ?? null])),
          newValue: body,
        },
      ],
      { session },
    );
    return after!;
  }).catch((error: unknown) => {
    throw serviceConflict(error) ?? error;
  });
  await invalidateAvailability(req.tenant!.id, staffId);
  res.json({ data: adminStaffView(updated, true) });
});

adminRoutes.put('/staff/:id/working-hours', requireAdminRole, async (req, res) => {
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

adminRoutes.get('/schedule', async (req, res) => {
  const query = z.object({ staffId: objectId, date: z.iso.date(), serviceId: objectId.optional() }).parse(req.query);
  const tenant = req.tenant!;
  const day = parseLocalDate(query.date, tenant.timezone);
  const dayStart = day.startOf('day').toJSDate();
  const dayEnd = day.plus({ days: 1 }).startOf('day').toJSDate();
  const staff = await StaffModel.findOne({ _id: query.staffId, appId: tenant.id }).lean();
  if (!staff) throw notFound('Staff member');
  const range = { appId: tenant.id, staffId: query.staffId, startsAt: { $lt: dayEnd }, endsAt: { $gt: dayStart } };
  const [appointments, blocks, bookable] = await Promise.all([
    AppointmentModel.find({ ...range, status: { $in: ['BOOKED', 'HOLD'] } })
      .populate('serviceId', 'name')
      .lean(),
    BlockedSlotModel.find(range).sort({ startsAt: 1 }).lean(),
    query.serviceId
      ? getAvailability(tenant, { staffId: query.staffId, serviceId: query.serviceId, date: query.date }).then(
          (result) => new Set(result.slots.map((slot) => Date.parse(slot.start))),
        )
      : Promise.resolve(null),
  ]);
  const grid = buildScheduleGrid({
    windows: workingWindows(staff.workingHours, query.date, tenant.timezone),
    intervalMinutes: tenant.slotIntervalMinutes,
    nowMs: Date.now(),
    blocks: blocks.map((block) => ({
      id: block._id.toString(),
      startMs: block.startsAt.getTime(),
      endMs: block.endsAt.getTime(),
    })),
    appointments: appointments.map((appointment) => ({
      id: appointment._id.toString(),
      status: appointment.status as 'BOOKED' | 'HOLD',
      startMs: appointment.startsAt.getTime(),
      endMs: appointment.endsAt.getTime(),
      holdExpiresAtMs: appointment.holdExpiresAt?.getTime() ?? null,
      serviceName:
        typeof appointment.serviceId === 'object' && appointment.serviceId && 'name' in appointment.serviceId
          ? String(appointment.serviceId.name)
          : null,
    })),
  });
  const iso = (ms: number) => DateTime.fromMillis(ms, { zone: 'utc' }).toISO()!;
  res.json({
    data: {
      date: query.date,
      timezone: tenant.timezone,
      intervalMinutes: tenant.slotIntervalMinutes,
      staff: { id: staff._id.toString(), name: staff.name },
      slots: grid.map((slot) => ({
        start: iso(slot.startMs),
        end: iso(slot.endMs),
        localStart: DateTime.fromMillis(slot.startMs, { zone: tenant.timezone }).toISO(),
        status: slot.status,
        past: slot.past,
        blockId: slot.blockId ?? null,
        bookingId: slot.bookingId ?? null,
        serviceName: slot.serviceName ?? null,
        ...(bookable ? { bookable: bookable.has(slot.startMs) } : {}),
      })),
      blocks: blocks.map(blockView),
    },
  });
});

adminRoutes.get('/block-slot', async (req, res) => {
  const query = z
    .object({ staffId: objectId.optional(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
    .refine((value) => Date.parse(value.from) < Date.parse(value.to), { message: 'from must be before to' })
    .parse(req.query);
  const blocks = await BlockedSlotModel.find({
    appId: req.tenant!.id,
    ...(query.staffId ? { staffId: query.staffId } : {}),
    startsAt: { $lt: new Date(query.to) },
    endsAt: { $gt: new Date(query.from) },
  })
    .sort({ startsAt: 1 })
    .lean();
  res.json({ data: blocks.map(blockView) });
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
      staffId: objectId.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .refine((value) => Date.parse(value.from) < Date.parse(value.to), { message: 'from must be before to' })
    .parse(req.query);
  const filter = {
    appId: req.tenant!.id,
    startsAt: { $gte: new Date(query.from), $lt: new Date(query.to) },
    ...(query.status ? { status: query.status } : {}),
    ...(query.staffId ? { staffId: query.staffId } : {}),
  };
  const [bookings, total] = await Promise.all([
    AppointmentModel.find(filter)
      .sort({ startsAt: 1 })
      .skip(query.offset)
      .limit(query.limit)
      .populate('serviceId', 'name')
      .populate('staffId', 'name')
      .lean(),
    AppointmentModel.countDocuments(filter),
  ]);
  const customerIds = bookings.flatMap((booking) => (booking.customerId ? [booking.customerId] : []));
  const customers = await CustomerModel.find({ _id: { $in: customerIds }, appId: req.tenant!.id }).lean();
  const customerById = new Map(customers.map((customer) => [customer._id.toString(), customer.dataEncrypted]));
  const customerFor = (booking: (typeof bookings)[number]) => {
    const encrypted =
      (booking.customerId ? customerById.get(booking.customerId.toString()) : null) ?? booking.customerDataEncrypted;
    if (!encrypted) return null;
    const details = decryptJson<GuestDetails>(encrypted, env.encryptionKey);
    return { name: details.name ?? null, phone: details.phone ?? null, socialHandle: details.socialHandle ?? null };
  };
  res.json({
    data: bookings.map((booking) => ({
      id: booking._id.toString(),
      status: booking.status,
      startsAt: booking.startsAt.toISOString(),
      serviceEndsAt: booking.serviceEndsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      serviceName:
        typeof booking.serviceId === 'object' && booking.serviceId && 'name' in booking.serviceId
          ? booking.serviceId.name
          : null,
      staffId:
        typeof booking.staffId === 'object' && booking.staffId && '_id' in booking.staffId
          ? booking.staffId._id.toString()
          : String(booking.staffId),
      staffName:
        typeof booking.staffId === 'object' && booking.staffId && 'name' in booking.staffId
          ? booking.staffId.name
          : null,
      customer: customerFor(booking),
      cancellationReason: booking.cancellationReason ?? null,
      localStart: DateTime.fromJSDate(booking.startsAt).setZone(req.tenant!.timezone).toISO(),
    })),
    meta: { total, limit: query.limit, offset: query.offset },
  });
});

adminRoutes.post('/bookings/:id/cancel', async (req, res) => {
  const bookingId = objectId.parse(req.params.id);
  const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  res.json({ data: await cancelBooking(req.tenant!, bookingId, req.principal!, body.reason) });
});

adminRoutes.patch('/bookings/:id/reschedule', async (req, res) => {
  const bookingId = objectId.parse(req.params.id);
  const body = z.object({ newSlotStartTime: z.iso.datetime({ offset: true }) }).parse(req.body);
  res.json({
    data: await rescheduleBooking(req.tenant!, bookingId, req.principal!, body.newSlotStartTime, { bypassCutoff: true }),
  });
});
