import type { TimeRange } from './availability.js';

export type SlotStatus = 'OPEN' | 'BLOCKED' | 'BOOKED' | 'HELD';

export type GridAppointment = TimeRange & {
  id: string;
  status: 'BOOKED' | 'HOLD';
  holdExpiresAtMs?: number | null;
  serviceName?: string | null;
};

export type GridBlock = TimeRange & { id: string };

export type GridSlot = TimeRange & {
  status: SlotStatus;
  past: boolean;
  blockId?: string;
  bookingId?: string;
  serviceName?: string | null;
};

function overlaps(left: TimeRange, right: TimeRange): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

/**
 * Every interval-sized slot inside the working windows with its admin-facing status.
 * When several things overlap a slot the precedence is BOOKED > HELD > BLOCKED > OPEN;
 * holds that have expired at `nowMs` are ignored.
 */
export function buildScheduleGrid(input: {
  windows: TimeRange[];
  intervalMinutes: number;
  appointments: GridAppointment[];
  blocks: GridBlock[];
  nowMs: number;
}): GridSlot[] {
  const intervalMs = input.intervalMinutes * 60_000;
  const liveHolds = input.appointments.filter(
    (appointment) => appointment.status === 'HOLD' && (appointment.holdExpiresAtMs ?? 0) > input.nowMs,
  );
  const booked = input.appointments.filter((appointment) => appointment.status === 'BOOKED');
  const slots: GridSlot[] = [];

  for (const window of [...input.windows].sort((a, b) => a.startMs - b.startMs)) {
    for (let startMs = window.startMs; startMs + intervalMs <= window.endMs; startMs += intervalMs) {
      const slot = { startMs, endMs: startMs + intervalMs };
      const past = startMs < input.nowMs;
      const booking = booked.find((appointment) => overlaps(slot, appointment));
      if (booking) {
        slots.push({ ...slot, past, status: 'BOOKED', bookingId: booking.id, serviceName: booking.serviceName ?? null });
        continue;
      }
      const hold = liveHolds.find((appointment) => overlaps(slot, appointment));
      if (hold) {
        slots.push({ ...slot, past, status: 'HELD', bookingId: hold.id, serviceName: hold.serviceName ?? null });
        continue;
      }
      const block = input.blocks.find((candidate) => overlaps(slot, candidate));
      slots.push(block ? { ...slot, past, status: 'BLOCKED', blockId: block.id } : { ...slot, past, status: 'OPEN' });
    }
  }
  return slots;
}
