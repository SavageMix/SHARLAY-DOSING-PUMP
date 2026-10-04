import { describe, expect, it } from 'vitest';
import type { DoseEvent, PumpId } from '@reef/shared';
import {
  buildHistoryBuckets,
  bucketTotal,
  historyChartTitle,
  historyRangeStart,
  localDateKey,
  type HistoryBucket,
} from './history-chart';

// Pin a non-UTC zone: bucket boundaries must follow device-local wall clock,
// so a dose at 00:30 local must never be sliced into yesterday by UTC.
process.env.TZ = 'Pacific/Auckland';

const PUMPS: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const ALL_VISIBLE: Record<PumpId, boolean> = {
  alk: true,
  ca: true,
  no3: true,
  po4: true,
};

/** Local wall-clock parts → Date (device-local, never UTC-sliced). */
function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi);
}

function doseEvent(
  at: Date,
  partial: Partial<DoseEvent> = {},
): DoseEvent {
  return {
    id: `evt-${at.getTime()}-${Math.random()}`,
    pumpId: 'alk',
    requestedMl: 1,
    actualMl: 1,
    status: 'completed',
    source: 'schedule',
    scheduleId: 's1',
    missedDoseId: null,
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    error: null,
    ...partial,
  };
}

/** Mirrors the events-list filter in app/(tabs)/history.tsx. */
function listFilter(
  events: DoseEvent[],
  days: number,
  now: Date,
  pumpId?: PumpId,
) {
  const start = historyRangeStart(days, now);
  return events.filter((e) => {
    if (pumpId && e.pumpId !== pumpId) return false;
    return new Date(e.startedAt).getTime() >= start;
  });
}

function totalOf(buckets: HistoryBucket[]): number {
  return buckets.reduce((sum, b) => sum + bucketTotal(b, ALL_VISIBLE), 0);
}

describe('history chart bucketing', () => {
  it('titles match the selected range', () => {
    expect(historyChartTitle(1)).toBe('Today, hourly');
    expect(historyChartTitle(7)).toBe('Last 7 days');
    expect(historyChartTitle(30)).toBe('Last 30 days');
  });

  it('1-day range buckets into 24 local hours for today', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events = [
      doseEvent(local(2026, 9, 26, 0, 30), { actualMl: 1 }), // bucket 00
      doseEvent(local(2026, 9, 26, 13, 15), { actualMl: 2 }), // bucket 13
      doseEvent(local(2026, 9, 26, 23, 45), { actualMl: 4, pumpId: 'ca' }), // bucket 23
      doseEvent(local(2026, 9, 25, 23, 59), { actualMl: 8 }), // yesterday — excluded
    ];
    const buckets = buildHistoryBuckets(events, 1, now);
    expect(buckets).toHaveLength(24);
    expect(buckets[0].values.alk).toBe(1);
    expect(buckets[13].values.alk).toBe(2);
    expect(buckets[23].values.ca).toBe(4);
    expect(buckets[23].values.alk).toBe(0);
    expect(totalOf(buckets)).toBe(7); // the 8 mL from yesterday never leaks in
  });

  it('a dose at 00:30 local belongs to today, not yesterday (non-UTC zone)', () => {
    // In Auckland (+12/+13) this is still the previous day in UTC — UTC
    // date-slicing would put it in yesterday's bucket.
    const boundary = local(2026, 9, 26, 0, 30);
    expect(localDateKey(boundary)).toBe('2026-09-26');
    const buckets = buildHistoryBuckets(
      [doseEvent(boundary, { actualMl: 1.5 })],
      1,
      local(2026, 9, 26, 9, 0),
    );
    expect(buckets[0].values.alk).toBe(1.5);
    expect(buckets[23].values.alk).toBe(0);
  });

  it('7-day range: daily buckets, sums match the events list exactly', () => {
    const now = local(2026, 9, 26, 15, 0);
    const events = [
      doseEvent(local(2026, 9, 20, 6, 0), { actualMl: 1, pumpId: 'alk' }),
      doseEvent(local(2026, 9, 20, 18, 0), { actualMl: 2, pumpId: 'ca' }),
      doseEvent(local(2026, 9, 20, 3, 0), { actualMl: 5 }), // same day, pre-dawn — in window
      doseEvent(local(2026, 9, 24, 6, 0), { actualMl: 3, pumpId: 'no3' }),
      doseEvent(local(2026, 9, 26, 6, 0), { actualMl: 4, pumpId: 'po4' }),
      // Before the window start (9/20 00:00 local) — excluded everywhere.
      doseEvent(local(2026, 9, 19, 23, 30), { actualMl: 99 }),
      // Failed dose — flagged, never summed (the list shows it, totals don't).
      doseEvent(local(2026, 9, 25, 6, 0), {
        status: 'failed',
        actualMl: null,
        error: 'stalled',
      }),
    ];
    const buckets = buildHistoryBuckets(events, 7, now);
    expect(buckets).toHaveLength(7);
    expect(buckets[0].key).toBe('2026-09-20'); // oldest day first
    expect(totalOf(buckets)).toBe(15);
    // Same-window completed volume as computed by the list's own filter.
    const listCompleted = listFilter(events, 7, now)
      .filter((e) => e.status === 'completed' && e.actualMl !== null)
      .reduce((s, e) => s + (e.actualMl ?? 0), 0);
    expect(totalOf(buckets)).toBe(listCompleted);
    // Empty days render as explicit zero buckets, not gaps.
    expect(buckets.every((b) => PUMPS.every((p) => b.values[p] >= 0))).toBe(true);
    expect(buckets.some((b) => bucketTotal(b, ALL_VISIBLE) === 0)).toBe(true);
  });

  it('30-day range: one bucket per day, totals match the list', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events = [
      doseEvent(local(2026, 8, 28, 6, 0), { actualMl: 1 }), // first day of window
      doseEvent(local(2026, 9, 26, 6, 0), { actualMl: 2 }), // today
      doseEvent(local(2026, 8, 27, 23, 59), { actualMl: 99 }), // before window
    ];
    const buckets = buildHistoryBuckets(events, 30, now);
    expect(buckets).toHaveLength(30);
    expect(buckets[0].key).toBe('2026-08-28'); // oldest day first
    expect(buckets[29].key).toBe('2026-09-26'); // today last
    expect(totalOf(buckets)).toBe(3);
    const listCompleted = listFilter(events, 30, now)
      .filter((e) => e.status === 'completed' && e.actualMl !== null)
      .reduce((s, e) => s + (e.actualMl ?? 0), 0);
    expect(totalOf(buckets)).toBe(listCompleted);
  });

  it('pump filter isolates the series (same data, subset)', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events = [
      doseEvent(local(2026, 9, 25, 6, 0), { actualMl: 2, pumpId: 'alk' }),
      doseEvent(local(2026, 9, 25, 6, 5), { actualMl: 3, pumpId: 'ca' }),
      doseEvent(local(2026, 9, 25, 6, 10), { actualMl: 5, pumpId: 'alk' }),
    ];
    // Mirrors the component: the screen pre-filters events by the selected
    // pump before bucketing.
    const caOnly = buildHistoryBuckets(
      events.filter((e) => e.pumpId === 'ca'),
      7,
      now,
    );
    expect(totalOf(caOnly)).toBe(3);
    for (const b of caOnly) {
      expect(b.values.alk).toBe(0);
      expect(b.values.no3).toBe(0);
      expect(b.values.po4).toBe(0);
    }
  });

  it('all dose sources count toward totals: schedule, catchup, manual, prime', () => {
    const now = local(2026, 9, 26, 12, 0);
    const at = local(2026, 9, 26, 8, 0);
    const events = [
      doseEvent(at, { source: 'schedule', actualMl: 1 }),
      doseEvent(at, { source: 'catchup', actualMl: 2, missedDoseId: 'md-1' }),
      doseEvent(at, { source: 'manual', actualMl: 3 }),
      doseEvent(at, { source: 'prime', actualMl: 4 }),
    ];
    const buckets = buildHistoryBuckets(events, 1, now);
    expect(buckets[8].values.alk).toBe(10);
  });

  it('failed and interrupted doses flag the bucket but never inflate totals', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events = [
      // A day with ONLY a failed dose: visible via the flag, total stays 0.
      doseEvent(local(2026, 9, 24, 6, 0), {
        status: 'failed',
        actualMl: null,
        error: 'stalled',
      }),
      // Interrupted dose alongside a good one: the good one still counts.
      doseEvent(local(2026, 9, 25, 6, 0), {
        status: 'interrupted',
        actualMl: null,
        error: 'Power lost during dose — unknown volume delivered',
      }),
      doseEvent(local(2026, 9, 25, 18, 0), { actualMl: 2 }),
    ];
    const buckets = buildHistoryBuckets(events, 7, now);
    const failedDay = buckets.find((b) => b.key === '2026-09-24')!;
    expect(failedDay.failed).toBe(true);
    expect(bucketTotal(failedDay, ALL_VISIBLE)).toBe(0);
    const interruptedDay = buckets.find((b) => b.key === '2026-09-25')!;
    expect(interruptedDay.failed).toBe(true);
    expect(bucketTotal(interruptedDay, ALL_VISIBLE)).toBe(2); // only the completed dose
  });

  it('an event beyond the window (tomorrow) gets no bucket at all', () => {
    const now = local(2026, 9, 26, 12, 0);
    const buckets = buildHistoryBuckets(
      [doseEvent(local(2026, 9, 27, 6, 0), { actualMl: 50 })],
      7,
      now,
    );
    expect(totalOf(buckets)).toBe(0);
    expect(buckets.some((b) => b.failed)).toBe(false);
  });

  it('a running (in-flight) dose neither counts nor flags the bucket', () => {    const now = local(2026, 9, 26, 12, 0);
    const buckets = buildHistoryBuckets(
      [
        doseEvent(local(2026, 9, 26, 11, 0), {
          status: 'running',
          actualMl: null,
          finishedAt: null,
        }),
      ],
      1,
      now,
    );
    expect(buckets[11].values.alk).toBe(0);
    expect(buckets[11].failed).toBe(false);
  });
});
