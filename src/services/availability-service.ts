import { DateTime } from 'luxon';
import type { ClientSession } from 'mongoose';
import { buildAvailableSlots, mergeStaffSlots, type TimeRange } from '../domain/availability.js';
import { HttpError, notFound } from '../lib/errors.js';
import { AppointmentModel, BlockedSlotModel, ServiceModel, StaffModel } from '../models.js';
import { availabilityVersion, redis } from '../redis.js';
import type { AppTenant } from '../types.js';

export type AvailableSlot = {
  start: string;
  serviceEnd: string;
  endWithBuffer: string;
  localStart: string;
};

export type AvailabilityResult = {
  date: string;
  timezone: string;
  staff: { id: string; name: string };
  service: {
    id: string;
    name: string;
    baseDurationMinutes: number;
    bufferDurationMinutes: number;
  };
  slots: AvailableSlot[];
};

type ServiceDocument = {
  _id: { toString(): string };
  name: string;
  baseDurationMinutes: number;
  bufferDurationMinutes: number;
  resourceType: string;
};

type StaffDocument = {
  _id: { toString(): string };
  name: string;
  resourceType: string;
  workingHours: Array<{ dayOfWeek: number; startsAt: string; endsAt: string }>;
};

function localTime(date: string, time: string, zone: string): DateTime {
  const value = DateTime.fromISO(`${date}T${time}:00`, { zone });
  if (!value.isValid) throw new HttpError(400, 'INVALID_LOCAL_TIME', value.invalidExplanation ?? 'Invalid local time');
  return value;
}

export function parseLocalDate(date: string, timezone: string): DateTime {
  const day = DateTime.fromISO(date, { zone: timezone });
  if (!day.isValid || day.toISODate() !== date) {
    throw new HttpError(400, 'INVALID_DATE', 'date must be a valid YYYY-MM-DD value');
  }
  return day;
}

export async function getAvailability(
  tenant: AppTenant,
  input: {
    staffId: string;
    serviceId: string;
    date: string;
    includePast?: boolean;
    excludeAppointmentId?: string;
  },
  session?: ClientSession,
): Promise<AvailabilityResult> {
  const day = parseLocalDate(input.date, tenant.timezone);

  let cacheKey: string | null = null;
  if (!session && !input.excludeAppointmentId && !input.includePast && redis?.status === 'ready') {
    const version = await availabilityVersion(tenant.id, input.staffId, input.date);
    cacheKey = `availability:${tenant.id}:${input.staffId}:${input.serviceId}:${input.date}:${version}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as AvailabilityResult;
    } catch {
      cacheKey = null;
    }
  }

  const serviceQuery = ServiceModel.findOne({ _id: input.serviceId, appId: tenant.id, active: true }).lean();
  const staffQuery = StaffModel.findOne({ _id: input.staffId, appId: tenant.id, active: true }).lean();
  if (session) {
    serviceQuery.session(session);
    staffQuery.session(session);
  }
  const [serviceRaw, staffRaw] = session
    ? [await serviceQuery, await staffQuery]
    : await Promise.all([serviceQuery, staffQuery]);
  const service = serviceRaw as ServiceDocument | null;
  const staff = staffRaw as StaffDocument | null;
  if (!service) throw notFound('Service');
  if (!staff) throw notFound('Staff member');
  if (service.resourceType !== staff.resourceType) {
    throw new HttpError(400, 'INCOMPATIBLE_STAFF', 'This staff member cannot perform the selected service');
  }

  const dayOfWeek = day.weekday === 7 ? 0 : day.weekday;
  const windows = staff.workingHours
    .filter((hours) => hours.dayOfWeek === dayOfWeek)
    .map((hours) => ({
      startMs: localTime(input.date, hours.startsAt, tenant.timezone).toMillis(),
      endMs: localTime(input.date, hours.endsAt, tenant.timezone).toMillis(),
    }));

  const dayStart = day.startOf('day').toUTC().toJSDate();
  const dayEnd = day.plus({ days: 1 }).startOf('day').toUTC().toJSDate();
  const appointmentFilter: Record<string, unknown> = {
    appId: tenant.id,
    staffId: input.staffId,
    startsAt: { $lt: dayEnd },
    endsAt: { $gt: dayStart },
    $or: [{ status: 'BOOKED' }, { status: 'HOLD', holdExpiresAt: { $gt: new Date() } }],
  };
  if (input.excludeAppointmentId) appointmentFilter._id = { $ne: input.excludeAppointmentId };
  const blocksQuery = BlockedSlotModel.find({
    appId: tenant.id,
    staffId: input.staffId,
    startsAt: { $lt: dayEnd },
    endsAt: { $gt: dayStart },
  })
    .select({ startsAt: 1, endsAt: 1 })
    .lean();
  const appointmentsQuery = AppointmentModel.find(appointmentFilter)
    .select({ startsAt: 1, endsAt: 1 })
    .lean();
  if (session) {
    blocksQuery.session(session);
    appointmentsQuery.session(session);
  }
  const [blocks, appointments] = session
    ? [await blocksQuery, await appointmentsQuery]
    : await Promise.all([blocksQuery, appointmentsQuery]);
  const busy: TimeRange[] = [...blocks, ...appointments].map((row) => ({
    startMs: new Date(row.startsAt as Date).getTime(),
    endMs: new Date(row.endsAt as Date).getTime(),
  }));

  const totalMinutes = service.baseDurationMinutes + service.bufferDurationMinutes;
  const slots = buildAvailableSlots({
    windows,
    busy,
    durationMinutes: totalMinutes,
    intervalMinutes: tenant.slotIntervalMinutes,
    notBeforeMs: input.includePast ? undefined : Date.now(),
  }).map((range) => {
    const start = DateTime.fromMillis(range.startMs, { zone: 'utc' });
    return {
      start: start.toISO()!,
      serviceEnd: start.plus({ minutes: service.baseDurationMinutes }).toISO()!,
      endWithBuffer: DateTime.fromMillis(range.endMs, { zone: 'utc' }).toISO()!,
      localStart: start.setZone(tenant.timezone).toISO()!,
    };
  });

  const result: AvailabilityResult = {
    date: input.date,
    timezone: tenant.timezone,
    staff: { id: staff._id.toString(), name: staff.name },
    service: {
      id: service._id.toString(),
      name: service.name,
      baseDurationMinutes: service.baseDurationMinutes,
      bufferDurationMinutes: service.bufferDurationMinutes,
    },
    slots,
  };
  if (cacheKey && redis?.status === 'ready') {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 15);
    } catch {
      // Cache failures do not affect availability correctness.
    }
  }
  return result;
}

export type AnyStaffAvailabilityResult = Omit<AvailabilityResult, 'staff' | 'slots'> & {
  staff: Array<{ id: string; name: string }>;
  slots: Array<AvailableSlot & { staffIds: string[] }>;
};

/** Staff who can perform a service, in a stable order (by name). */
export async function compatibleStaff(
  tenant: AppTenant,
  serviceId: string,
): Promise<{ service: ServiceDocument; staff: StaffDocument[] }> {
  const service = (await ServiceModel.findOne({ _id: serviceId, appId: tenant.id, active: true }).lean()) as
    | ServiceDocument
    | null;
  if (!service) throw notFound('Service');
  const staff = (await StaffModel.find({ appId: tenant.id, active: true, resourceType: service.resourceType })
    .sort({ name: 1 })
    .lean()) as StaffDocument[];
  return { service, staff };
}

/** Availability for a service across every compatible staff member ("any available staff"). */
export async function getAnyStaffAvailability(
  tenant: AppTenant,
  input: { serviceId: string; date: string },
): Promise<AnyStaffAvailabilityResult> {
  parseLocalDate(input.date, tenant.timezone);
  const { service, staff } = await compatibleStaff(tenant, input.serviceId);
  const perStaff = await Promise.all(
    staff.map((member) =>
      getAvailability(tenant, { staffId: member._id.toString(), serviceId: input.serviceId, date: input.date }),
    ),
  );
  return {
    date: input.date,
    timezone: tenant.timezone,
    staff: staff.map((member) => ({ id: member._id.toString(), name: member.name })),
    service: {
      id: service._id.toString(),
      name: service.name,
      baseDurationMinutes: service.baseDurationMinutes,
      bufferDurationMinutes: service.bufferDurationMinutes,
    },
    slots: mergeStaffSlots(perStaff.map((result) => ({ staffId: result.staff.id, slots: result.slots }))),
  };
}
