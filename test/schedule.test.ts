import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScheduleGrid } from '../src/domain/schedule.js';

const m = 60_000;
const window = { startMs: 0, endMs: 60 * m };

describe('admin schedule grid', () => {
  it('splits working windows into interval slots that are open by default', () => {
    const grid = buildScheduleGrid({ windows: [window], intervalMinutes: 15, appointments: [], blocks: [], nowMs: -1 });
    assert.deepEqual(
      grid.map((slot) => [slot.startMs / m, slot.status]),
      [
        [0, 'OPEN'],
        [15, 'OPEN'],
        [30, 'OPEN'],
        [45, 'OPEN'],
      ],
    );
  });

  it('applies BOOKED > HELD > BLOCKED > OPEN precedence', () => {
    const grid = buildScheduleGrid({
      windows: [window],
      intervalMinutes: 15,
      nowMs: 0,
      blocks: [{ id: 'block', startMs: 0, endMs: 60 * m }],
      appointments: [
        { id: 'hold', status: 'HOLD', startMs: 0, endMs: 30 * m, holdExpiresAtMs: 99 * m },
        { id: 'booking', status: 'BOOKED', startMs: 0, endMs: 15 * m, serviceName: 'Hair Wash' },
      ],
    });
    assert.deepEqual(
      grid.map((slot) => [slot.status, slot.bookingId ?? slot.blockId]),
      [
        ['BOOKED', 'booking'],
        ['HELD', 'hold'],
        ['BLOCKED', 'block'],
        ['BLOCKED', 'block'],
      ],
    );
    assert.equal(grid[0]?.serviceName, 'Hair Wash');
  });

  it('ignores expired holds and marks past slots', () => {
    const grid = buildScheduleGrid({
      windows: [window],
      intervalMinutes: 30,
      nowMs: 20 * m,
      blocks: [],
      appointments: [{ id: 'old', status: 'HOLD', startMs: 0, endMs: 60 * m, holdExpiresAtMs: 10 * m }],
    });
    assert.deepEqual(
      grid.map((slot) => [slot.status, slot.past]),
      [
        ['OPEN', true],
        ['OPEN', false],
      ],
    );
  });

  it('marks every slot a multi-slot booking covers', () => {
    const grid = buildScheduleGrid({
      windows: [window],
      intervalMinutes: 15,
      nowMs: 0,
      blocks: [],
      appointments: [{ id: 'long', status: 'BOOKED', startMs: 10 * m, endMs: 40 * m }],
    });
    assert.deepEqual(
      grid.map((slot) => slot.status),
      ['BOOKED', 'BOOKED', 'BOOKED', 'OPEN'],
    );
  });

  it('returns no slots without working hours', () => {
    assert.deepEqual(buildScheduleGrid({ windows: [], intervalMinutes: 15, appointments: [], blocks: [], nowMs: 0 }), []);
  });
});
