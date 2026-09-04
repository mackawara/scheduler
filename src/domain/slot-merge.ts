export type StaffRef = { id: string; name: string };

export type StaffSlot = {
  start: string;
  serviceEnd: string;
  endWithBuffer: string;
  localStart: string;
};

export type MergedSlot = StaffSlot & {
  /** Everyone free for this slot, so the caller can offer a choice. */
  staff: StaffRef[];
};

/**
 * Collapses per-staff availability into one list keyed by start time. A slot two
 * stylists can both cover appears once, listing both.
 */
export function mergeStaffAvailability(
  perStaff: Array<{ staff: StaffRef; slots: StaffSlot[] }>,
): MergedSlot[] {
  const byStart = new Map<string, MergedSlot>();
  for (const { staff, slots } of perStaff) {
    for (const slot of slots) {
      const existing = byStart.get(slot.start);
      if (existing) {
        existing.staff.push(staff);
      } else {
        byStart.set(slot.start, { ...slot, staff: [staff] });
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Chooses who takes an "any available" booking: the candidate with the most
 * remaining free slots that day, so work spreads across the team instead of
 * stacking on whoever sorts first. Ties break on id to stay deterministic.
 */
export function leastLoadedStaffId(slots: MergedSlot[], startTime: string): string | null {
  const slot = slots.find((candidate) => candidate.start === startTime);
  if (!slot?.staff.length) return null;
  const freeSlotsByStaff = new Map<string, number>();
  for (const entry of slots) {
    for (const member of entry.staff) {
      freeSlotsByStaff.set(member.id, (freeSlotsByStaff.get(member.id) ?? 0) + 1);
    }
  }
  return [...slot.staff].sort(
    (a, b) => (freeSlotsByStaff.get(b.id) ?? 0) - (freeSlotsByStaff.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  )[0]!.id;
}
