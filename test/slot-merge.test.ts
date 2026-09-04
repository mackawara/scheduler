import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leastLoadedStaffId, mergeStaffAvailability, type StaffSlot } from '../src/domain/slot-merge.js';

function slot(start: string): StaffSlot {
  return { start, serviceEnd: start, endWithBuffer: start, localStart: start };
}

const naomi = { id: 'a1', name: 'Naomi' };
const tendai = { id: 'b2', name: 'Tendai' };

describe('any-available slot merging', () => {
  it('lists every free staff member on a shared start time exactly once', () => {
    const merged = mergeStaffAvailability([
      { staff: naomi, slots: [slot('09:00'), slot('10:00')] },
      { staff: tendai, slots: [slot('10:00')] },
    ]);
    assert.deepEqual(
      merged.map((entry) => entry.start),
      ['09:00', '10:00'],
    );
    assert.deepEqual(merged[1]!.staff, [naomi, tendai]);
    assert.deepEqual(merged[0]!.staff, [naomi]);
  });

  it('sorts merged slots chronologically regardless of staff order', () => {
    const merged = mergeStaffAvailability([
      { staff: tendai, slots: [slot('14:00')] },
      { staff: naomi, slots: [slot('09:00')] },
    ]);
    assert.deepEqual(
      merged.map((entry) => entry.start),
      ['09:00', '14:00'],
    );
  });

  it('returns no slots when nobody is qualified or free', () => {
    assert.deepEqual(mergeStaffAvailability([]), []);
    assert.deepEqual(mergeStaffAvailability([{ staff: naomi, slots: [] }]), []);
  });
});

describe('auto-assigning a stylist', () => {
  it('picks the staff member with the most free time left that day', () => {
    const merged = mergeStaffAvailability([
      { staff: naomi, slots: [slot('09:00')] },
      { staff: tendai, slots: [slot('09:00'), slot('11:00'), slot('13:00')] },
    ]);
    assert.equal(leastLoadedStaffId(merged, '09:00'), tendai.id);
  });

  it('breaks ties deterministically so replays assign the same person', () => {
    const merged = mergeStaffAvailability([
      { staff: tendai, slots: [slot('09:00')] },
      { staff: naomi, slots: [slot('09:00')] },
    ]);
    assert.equal(leastLoadedStaffId(merged, '09:00'), naomi.id);
    assert.equal(leastLoadedStaffId(merged, '09:00'), naomi.id);
  });

  it('returns null for a start time nobody offers', () => {
    const merged = mergeStaffAvailability([{ staff: naomi, slots: [slot('09:00')] }]);
    assert.equal(leastLoadedStaffId(merged, '17:00'), null);
  });
});
