type ServiceRow = {
  _id: { toString(): string };
  name: string;
  description?: string | null;
  baseDurationMinutes: number;
  bufferDurationMinutes: number;
  resourceType: string;
  priceCents: number;
  currency: string;
  catalogRetailerId?: string | null;
  active?: boolean;
};

type StaffRow = {
  _id: { toString(): string };
  name: string;
  resourceType: string;
  workingHours?: Array<{ dayOfWeek: number; startsAt: string; endsAt: string }>;
  active?: boolean;
};

export function serviceView(service: ServiceRow) {
  return {
    id: service._id.toString(),
    name: service.name,
    description: service.description ?? null,
    baseDurationMinutes: service.baseDurationMinutes,
    bufferDurationMinutes: service.bufferDurationMinutes,
    resourceType: service.resourceType,
    priceCents: service.priceCents,
    currency: service.currency,
    catalogRetailerId: service.catalogRetailerId ?? null,
  };
}

export function adminServiceView(service: ServiceRow) {
  return { ...serviceView(service), active: service.active ?? true };
}

export function adminStaffView(staff: StaffRow, includeHours = false) {
  return {
    id: staff._id.toString(),
    name: staff.name,
    resourceType: staff.resourceType,
    active: staff.active ?? true,
    ...(includeHours
      ? {
          workingHours: (staff.workingHours ?? []).map(({ dayOfWeek, startsAt, endsAt }) => ({ dayOfWeek, startsAt, endsAt })),
        }
      : {}),
  };
}
