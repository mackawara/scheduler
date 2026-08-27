import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { minuteClaimTimes } from '../src/domain/claims.js';

describe('MongoDB minute claims', () => {
  it('claims every occupied minute without claiming the exclusive end', () => {
    const start = new Date('2026-08-27T09:00:00.000Z');
    const end = new Date('2026-08-27T09:03:00.000Z');
    assert.deepEqual(
      minuteClaimTimes(start, end).map((value) => value.toISOString()),
      [
        '2026-08-27T09:00:00.000Z',
        '2026-08-27T09:01:00.000Z',
        '2026-08-27T09:02:00.000Z',
      ],
    );
  });
});
