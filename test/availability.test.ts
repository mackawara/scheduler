import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAvailableSlots, mergeRanges } from '../src/domain/availability.js';

const minute = 60_000;

describe('availability gap calculation', () => {
  it('only returns starts where the full service and buffer fit', () => {
    const slots = buildAvailableSlots({
      windows: [{ startMs: 0, endMs: 8 * 60 * minute }],
      busy: [{ startMs: 3 * 60 * minute, endMs: 4 * 60 * minute }],
      durationMinutes: 135,
      intervalMinutes: 15,
    });
    assert.ok(slots.every((slot) => slot.endMs <= 3 * 60 * minute || slot.startMs >= 4 * 60 * minute));
    assert.equal(slots.some((slot) => slot.startMs === 45 * minute), true);
    assert.equal(slots.some((slot) => slot.startMs === 2 * 60 * minute), false);
  });

  it('merges touching and overlapping busy ranges', () => {
    assert.deepEqual(
      mergeRanges([
        { startMs: 10, endMs: 20 },
        { startMs: 20, endMs: 30 },
        { startMs: 15, endMs: 25 },
      ]),
      [{ startMs: 10, endMs: 30 }],
    );
  });
});
