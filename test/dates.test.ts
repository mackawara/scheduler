import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localDateRange, localToday } from '../src/domain/dates.js';

describe('local date helpers', () => {
  it('uses the app timezone for "today" near midnight UTC', () => {
    // 22:30 UTC on 19 Oct is already 00:30 on 20 Oct in Harare (UTC+2).
    const instant = Date.parse('2026-10-19T22:30:00Z');
    assert.equal(localToday('Africa/Harare', instant), '2026-10-20');
    assert.equal(localToday('UTC', instant), '2026-10-19');
  });

  it('produces consecutive calendar dates across month ends', () => {
    assert.deepEqual(localDateRange('2026-10-30', 4, 'Africa/Harare'), [
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('does not skip or repeat dates over a DST change', () => {
    // Europe/London falls back on 25 Oct 2026.
    assert.deepEqual(localDateRange('2026-10-24', 3, 'Europe/London'), ['2026-10-24', '2026-10-25', '2026-10-26']);
  });
});
