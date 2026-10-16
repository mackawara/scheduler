import { DateTime } from 'luxon';

/** `days` consecutive local calendar dates (YYYY-MM-DD) starting at `from` in `timezone`. */
export function localDateRange(from: string, days: number, timezone: string): string[] {
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  return Array.from({ length: days }, (_, offset) => start.plus({ days: offset }).toISODate()!);
}

/** Today's local date in `timezone` at instant `nowMs`. */
export function localToday(timezone: string, nowMs = Date.now()): string {
  return DateTime.fromMillis(nowMs, { zone: timezone }).toISODate()!;
}
