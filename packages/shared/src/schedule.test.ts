import { describe, expect, it } from 'vitest';
import {
  getMissedDueDates,
  getNextDueDate,
  getPreviousDueDate,
} from './schedule.js';

// Schedule interpretation must be device-local wall clock, not UTC. Pin a
// non-UTC zone where the platform honours runtime TZ changes (POSIX); the
// wall-clock assertions below hold regardless.
process.env.TZ = 'Europe/London';

// 2026-08-23 10:00 local — during BST (+0100) in Europe/London, so the old
// UTC-interpretation code paths produce observably different results there.
const AUGUST_MORNING = new Date(2026, 7, 23, 10, 0, 0, 0);

function local(d: Date): string {
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

describe('schedule due dates are device-local wall clock', () => {
  it('a "10:32" schedule next-fires at 10:32 local', () => {
    const schedule = {
      timesPerDay: 1,
      startTime: '10:32',
      repeatEveryNDays: 1,
    };
    const next = getNextDueDate(schedule, AUGUST_MORNING);
    expect(next).not.toBeNull();
    expect(local(next!)).toBe('10:32');
    // Same local calendar day, and strictly in the near future.
    expect(next!.getDate()).toBe(AUGUST_MORNING.getDate());
    expect(next!.getTime() - AUGUST_MORNING.getTime()).toBeLessThan(
      60 * 60 * 1000,
    );
  });

  it('at exactly 10:32 local the next fire is tomorrow at 10:32 local', () => {
    const schedule = {
      timesPerDay: 1,
      startTime: '10:32',
      repeatEveryNDays: 1,
    };
    const atDue = new Date(2026, 7, 23, 10, 32, 0, 0);
    const next = getNextDueDate(schedule, atDue);
    expect(next!.getDate()).toBe(24);
    expect(local(next!)).toBe('10:32');
  });

  it('previous due at 11:00 local is today at 10:32 local', () => {
    const schedule = {
      timesPerDay: 1,
      startTime: '10:32',
      repeatEveryNDays: 1,
    };
    const previous = getPreviousDueDate(
      schedule,
      new Date(2026, 7, 23, 11, 0, 0, 0),
    );
    expect(previous!.getDate()).toBe(23);
    expect(local(previous!)).toBe('10:32');
  });

  it('multi-dose schedule fires at local wall-clock slots', () => {
    const schedule = {
      timesPerDay: 3,
      startTime: '08:00',
      repeatEveryNDays: 1,
    };
    const next = getNextDueDate(schedule, AUGUST_MORNING);
    // Slots are 08:00, 16:00, 00:00 — 10:00 local means 16:00 local is next.
    expect(local(next!)).toBe('16:00');
  });

  it('missed-dose detection reports local wall-clock due dates', () => {
    const schedule = {
      timesPerDay: 1,
      startTime: '10:32',
      repeatEveryNDays: 1,
    };
    const lastRunAt = new Date(2026, 7, 22, 10, 32, 0, 0); // yesterday, local
    const now = new Date(2026, 7, 23, 11, 0, 0, 0);
    const missed = getMissedDueDates(schedule, lastRunAt, now);
    expect(missed).toHaveLength(1);
    expect(missed[0].getDate()).toBe(23);
    expect(local(missed[0])).toBe('10:32');
  });

  it('keeps 06:00 wall clock across the BST spring-forward transition', () => {
    // Europe/London jumps GMT -> BST at 01:00 on 2026-03-29.
    const schedule = {
      timesPerDay: 1,
      startTime: '06:00',
      repeatEveryNDays: 1,
    };
    const before = getNextDueDate(schedule, new Date(2026, 2, 28, 12, 0, 0, 0));
    expect(before!.getDate()).toBe(29);
    expect(local(before!)).toBe('06:00');
  });
});
