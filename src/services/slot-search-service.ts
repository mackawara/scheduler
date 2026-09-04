import { leastLoadedStaffId, mergeStaffAvailability, type MergedSlot } from '../domain/slot-merge.js';
import { notFound } from '../lib/errors.js';
import { ServiceModel, StaffModel } from '../models.js';
import type { AppTenant } from '../types.js';
import { getAvailability } from './availability-service.js';

export type { MergedSlot };

export type SlotSearchResult = {
  date: string;
  timezone: string;
  service: {
    id: string;
    name: string;
    baseDurationMinutes: number;
    bufferDurationMinutes: number;
    priceCents: number;
    currency: string;
  };
  staff: Array<{ id: string; name: string }>;
  slots: MergedSlot[];
};

/**
 * Availability for a service across every staff member qualified to perform it.
 * Slots offered by more than one person collapse into a single entry that lists
 * all of them, so a customer can book "any available" or pick a stylist.
 */
export async function searchSlots(
  tenant: AppTenant,
  input: { serviceId: string; date: string; staffId?: string },
): Promise<SlotSearchResult> {
  const service = await ServiceModel.findOne({ _id: input.serviceId, appId: tenant.id, active: true }).lean();
  if (!service) throw notFound('Service');

  const candidates = await StaffModel.find({
    appId: tenant.id,
    active: true,
    resourceType: service.resourceType,
    ...(input.staffId ? { _id: input.staffId } : {}),
  })
    .sort({ name: 1 })
    .lean();
  if (input.staffId && !candidates.length) throw notFound('Staff member');

  const perStaff = await Promise.all(
    candidates.map(async (member) => ({
      member,
      availability: await getAvailability(tenant, {
        staffId: member._id.toString(),
        serviceId: input.serviceId,
        date: input.date,
      }),
    })),
  );

  const slots = mergeStaffAvailability(
    perStaff.map(({ member, availability }) => ({
      staff: { id: member._id.toString(), name: member.name },
      slots: availability.slots,
    })),
  );

  return {
    date: input.date,
    timezone: tenant.timezone,
    service: {
      id: service._id.toString(),
      name: service.name,
      baseDurationMinutes: service.baseDurationMinutes,
      bufferDurationMinutes: service.bufferDurationMinutes,
      priceCents: service.priceCents,
      currency: service.currency,
    },
    staff: candidates.map((member) => ({ id: member._id.toString(), name: member.name })),
    slots,
  };
}

/**
 * Picks the staff member for an "any available" hold. Least-loaded first so
 * bookings spread across the team instead of stacking on the first name.
 */
export async function pickStaffForSlot(
  tenant: AppTenant,
  input: { serviceId: string; date: string; slotStartMs: number },
): Promise<string | null> {
  const search = await searchSlots(tenant, { serviceId: input.serviceId, date: input.date });
  const match = search.slots.find((candidate) => Date.parse(candidate.start) === input.slotStartMs);
  return match ? leastLoadedStaffId(search.slots, match.start) : null;
}
