import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeStaffSlots } from '../src/domain/availability.js';

const slot = (start: string) => ({ start, localStart: start });

describe('any-staff slot merge', () => {
  it('unions slots, de-duplicates by start and records free staff', () => {
    const merged = mergeStaffSlots([
      { staffId: 'a', slots: [slot('2026-10-20T07:00:00.000Z'), slot('2026-10-20T08:00:00.000Z')] },
      { staffId: 'b', slots: [slot('2026-10-20T08:00:00.000Z'), slot('2026-10-20T06:00:00.000Z')] },
    ]);
    assert.deepEqual(
      merged.map((entry) => [entry.start, entry.staffIds]),
      [
        ['2026-10-20T06:00:00.000Z', ['b']],
        ['2026-10-20T07:00:00.000Z', ['a']],
        ['2026-10-20T08:00:00.000Z', ['a', 'b']],
      ],
    );
  });

  it('treats equal instants with different offsets as the same slot', () => {
    const merged = mergeStaffSlots([
      { staffId: 'a', slots: [slot('2026-10-20T07:00:00.000Z')] },
      { staffId: 'b', slots: [slot('2026-10-20T09:00:00.000+02:00')] },
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]?.staffIds, ['a', 'b']);
  });

  it('returns nothing when no staff are free', () => {
    assert.deepEqual(mergeStaffSlots([]), []);
  });
});
