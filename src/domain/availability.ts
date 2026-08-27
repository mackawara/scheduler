export type TimeRange = { startMs: number; endMs: number };

export type AvailabilityInput = {
  windows: TimeRange[];
  busy: TimeRange[];
  durationMinutes: number;
  intervalMinutes: number;
  notBeforeMs?: number;
};

function overlaps(left: TimeRange, right: TimeRange): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((range) => range.startMs < range.endMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: TimeRange[] = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (!previous || current.startMs > previous.endMs) {
      merged.push({ ...current });
    } else {
      previous.endMs = Math.max(previous.endMs, current.endMs);
    }
  }
  return merged;
}

export function buildAvailableSlots(input: AvailabilityInput): TimeRange[] {
  const durationMs = input.durationMinutes * 60_000;
  const intervalMs = input.intervalMinutes * 60_000;
  const busy = mergeRanges(input.busy);
  const slots: TimeRange[] = [];

  for (const window of input.windows) {
    let candidate = window.startMs;
    if (input.notBeforeMs && candidate < input.notBeforeMs) {
      const steps = Math.ceil((input.notBeforeMs - candidate) / intervalMs);
      candidate += steps * intervalMs;
    }
    while (candidate + durationMs <= window.endMs) {
      const slot = { startMs: candidate, endMs: candidate + durationMs };
      if (!busy.some((range) => overlaps(slot, range))) slots.push(slot);
      candidate += intervalMs;
    }
  }
  return slots;
}
