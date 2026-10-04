import { describe, expect, it } from 'vitest';
import type { DoseEvent, PumpId } from '@reef/shared';
import {
  bucketTotal,
  buildHistoryBuckets,
  groupEventsByDay,
  localDateKey,
  type HistoryBucket,
} from './history-chart';
import {
  buildMonthHierarchy,
  flattenHierarchy,
  groupDaysByMonth,
  mondayOfWeek,
  weekLabel,
  type HistoryMonthGroup,
} from './history-groups';

// Non-UTC zone: all grouping must follow device-local wall clock.
process.env.TZ = 'Pacific/Auckland';

const PUMPS: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const ALL_VISIBLE: Record<PumpId, boolean> = {
  alk: true,
  ca: true,
  no3: true,
  po4: true,
};

function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi);
}

function doseEvent(at: Date, partial: Partial<DoseEvent> = {}): DoseEvent {
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

function totalOf(buckets: HistoryBucket[]): number {
  return buckets.reduce((sum, b) => sum + bucketTotal(b, ALL_VISIBLE), 0);
}

describe('90-day chart bucketing', () => {
  it('builds one bucket per day over the 90-day local window', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events = [
      doseEvent(local(2026, 6, 29, 6, 0), { actualMl: 1 }), // window start
      doseEvent(local(2026, 9, 26, 6, 0), { actualMl: 2 }), // today
      doseEvent(local(2026, 6, 28, 23, 59), { actualMl: 99 }), // before window
    ];
    const buckets = buildHistoryBuckets(events, 90, now);
    expect(buckets).toHaveLength(90);
    expect(buckets[0].key).toBe('2026-06-29');
    expect(buckets[89].key).toBe('2026-09-26');
    expect(totalOf(buckets)).toBe(3);
  });

  it('drill-down from 90d buckets hourly for the tapped day only', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events = [
      doseEvent(local(2026, 9, 24, 6, 0), { actualMl: 1 }),
      doseEvent(local(2026, 9, 24, 14, 30), { actualMl: 2, pumpId: 'ca' }),
      doseEvent(local(2026, 9, 25, 6, 0), { actualMl: 4 }),
    ];
    const buckets = buildHistoryBuckets(events, 90, now, '2026-09-24');
    expect(buckets).toHaveLength(24);
    expect(buckets[6].values.alk).toBe(1);
    expect(buckets[14].values.ca).toBe(2);
    expect(totalOf(buckets)).toBe(3);
  });
});

describe('weeks — Monday to Sunday, device-local', () => {
  it('mondayOfWeek anchors Sun→previous Mon, Mon→itself', () => {
    // 2026-09-20 is a Sunday, 2026-09-21 a Monday.
    expect(localDateKey(mondayOfWeek(local(2026, 9, 20, 23, 59)))).toBe(
      '2026-09-14',
    );
    expect(localDateKey(mondayOfWeek(local(2026, 9, 21, 0, 1)))).toBe(
      '2026-09-21',
    );
    expect(localDateKey(mondayOfWeek(local(2026, 9, 26, 12, 0)))).toBe(
      '2026-09-21',
    );
  });

  it('weekLabel formats within and across months', () => {
    // Month abbreviations are ICU-locale data ('Sep' vs 'Sept') — pin the
    // RANGE logic, not the locale string.
    const sep = local(2026, 9, 1).toLocaleDateString(undefined, { month: 'short' });
    const aug = local(2026, 8, 1).toLocaleDateString(undefined, { month: 'short' });
    expect(weekLabel(local(2026, 9, 21))).toBe(`21–27 ${sep}`);
    // Mon 31 Aug – Sun 6 Sep straddles the month boundary.
    expect(weekLabel(local(2026, 8, 31))).toBe(`31 ${aug}–6 ${sep}`);
  });

  it('a Sunday and the following Monday land in different week groups', () => {
    const days = groupEventsByDay([
      doseEvent(local(2026, 9, 20, 23, 0), { id: 'sun' }),
      doseEvent(local(2026, 9, 21, 1, 0), { id: 'mon' }),
    ]);
    const months = groupDaysByMonth(days);
    const weeks = months[0].weeks;
    expect(weeks).toHaveLength(2);
    expect(weeks.map((w) => w.key).sort()).toEqual([
      '2026-09-14',
      '2026-09-21',
    ]);
  });
});

describe('month → week → day hierarchy', () => {
  const events = [
    // September: one bad day (failed dose) mid-week…
    doseEvent(local(2026, 9, 24, 6, 0), { actualMl: 2 }),
    doseEvent(local(2026, 9, 24, 18, 0), {
      status: 'failed',
      actualMl: null,
      error: 'stalled',
    }),
    doseEvent(local(2026, 9, 26, 6, 0), { actualMl: 4 }),
    // …and an August day in the same Monday-anchored week as 31 Aug.
    doseEvent(local(2026, 8, 31, 8, 0), { actualMl: 8 }),
  ];

  it('groups by month and week, newest first at every level', () => {
    const months = buildMonthHierarchy(events);
    expect(months.map((m) => m.key)).toEqual(['2026-09', '2026-08']);
    expect(months[0].label).toContain('September');
    // Both September days sit in the Mon 21 – Sun 27 week.
    expect(months[0].weeks.map((w) => w.key)).toEqual(['2026-09-21']);
    expect(months[0].weeks[0].label).toContain('21–27');
    expect(months[0].weeks[0].days.map((d) => d.key)).toEqual([
      '2026-09-26',
      '2026-09-24', // newest day first within the week
    ]);
  });

  it('month/week/day sums are mutually consistent and equal the chart buckets', () => {
    const now = local(2026, 9, 26, 12, 0);
    const months = buildMonthHierarchy(events);
    const buckets = buildHistoryBuckets(events, 90, now);
    const chartTotal = totalOf(buckets);

    let hierarchyTotal = 0;
    for (const month of months) {
      const weekSumMl = month.weeks.reduce((s, w) => s + w.deliveredMl, 0);
      const weekSumEvents = month.weeks.reduce((s, w) => s + w.eventCount, 0);
      const weekSumFailed = month.weeks.reduce((s, w) => s + w.failedCount, 0);
      expect(month.deliveredMl).toBeCloseTo(weekSumMl);
      expect(month.eventCount).toBe(weekSumEvents);
      expect(month.failedCount).toBe(weekSumFailed);
      for (const week of month.weeks) {
        expect(week.deliveredMl).toBeCloseTo(
          week.days.reduce((s, d) => s + d.deliveredMl, 0),
        );
        for (const day of week.days) {
          const bucket = buckets.find((b) => b.key === day.key)!;
          expect(day.deliveredMl).toBeCloseTo(
            bucketTotal(bucket, ALL_VISIBLE),
          );
        }
      }
      hierarchyTotal += month.deliveredMl;
    }
    expect(hierarchyTotal).toBeCloseTo(chartTotal);
  });

  it('the failed badge bubbles up: day → week → month', () => {
    const months = buildMonthHierarchy(events);
    const sept = months.find((m) => m.key === '2026-09')!;
    expect(sept.failedCount).toBe(1);
    const badWeek = sept.weeks.find((w) => w.key === '2026-09-21')!;
    expect(badWeek.failedCount).toBe(1);
    expect(badWeek.deliveredMl).toBe(6); // 2 + 4; the failed dose never counted
    expect(sept.deliveredMl).toBe(6); // September only — the 8 mL is August
  });

  it('a clean month shows no failed badge', () => {
    const months = buildMonthHierarchy([
      doseEvent(local(2026, 9, 26, 6, 0), { actualMl: 1 }),
    ]);
    expect(months[0].failedCount).toBe(0);
  });
});

describe('flattenHierarchy — only expanded sections render', () => {
  const months: HistoryMonthGroup[] = buildMonthHierarchy([
    doseEvent(local(2026, 9, 24, 6, 0), { id: 'a', actualMl: 1 }),
    doseEvent(local(2026, 9, 26, 6, 0), { id: 'b', actualMl: 2 }),
    doseEvent(local(2026, 9, 26, 8, 0), { id: 'c', actualMl: 3 }),
  ]);

  it('fully collapsed renders only the top-level headers, zero events', () => {
    // Collapsed sections cost ONE row each and hide everything below them —
    // deeper headers only exist once their parent is expanded.
    const rows = flattenHierarchy(months, () => false);
    expect(rows.map((r) => r.kind)).toEqual(['month']);
    expect(rows.some((r) => r.kind === 'event')).toBe(false);
    // Month expanded, weeks collapsed: month + one header per week.
    const monthOpen = flattenHierarchy(months, (kind) => kind === 'month');
    expect(monthOpen.map((r) => r.kind)).toEqual(['month', 'week']);
  });

  it('screen-default expansion (newest month + week + day) shows only the newest day’s events', () => {
    // Mirrors the screen's defaults: a section expands when it holds the
    // newest entries of its level.
    const newestMonth = months[0].key;
    const newestWeek = months[0].weeks[0].key;
    const newestDay = months[0].weeks[0].days[0].key;
    const rows = flattenHierarchy(months, (kind, key) =>
      kind === 'month'
        ? key === newestMonth
        : kind === 'week'
          ? key === newestWeek
          : key === newestDay,
    );
    const eventRows = rows.filter((r) => r.kind === 'event');
    expect(eventRows).toHaveLength(2); // the two 9/26 events
    expect(eventRows.map((r) => (r.kind === 'event' ? r.event.id : ''))).toEqual([
      'c',
      'b',
    ]);
    // The older day (9/24) shows its header but not its event.
    expect(
      rows.some((r) => r.kind === 'day' && r.group.key === '2026-09-24'),
    ).toBe(true);
    expect(
      rows.some(
        (r) => r.kind === 'event' && r.event.id === 'a',
      ),
    ).toBe(false);
  });

  it('override expansion reveals deeper rows on demand', () => {
    const rows = flattenHierarchy(months, (kind, key) =>
      kind === 'month'
        ? true
        : kind === 'week'
          ? true
          : key === '2026-09-24',
    );
    expect(rows.filter((r) => r.kind === 'event')).toHaveLength(1);
    expect(rows.some((r) => r.kind === 'event' && r.event.id === 'a')).toBe(
      true,
    );
  });
});

describe('performance — synthetic 90d × 4-pump dataset (~9k events)', () => {
  it('hierarchy + chart bucketing + flatten stay well under a second', () => {
    const now = local(2026, 9, 26, 12, 0);
    const events: DoseEvent[] = [];
    let n = 0;
    for (let day = 0; day < 90; day++) {
      for (const pumpId of PUMPS) {
        for (let k = 0; k < 25; k++) {
          const d = new Date(now);
          d.setDate(d.getDate() - day);
          d.setHours(k, (n * 7) % 60, 0, 0);
          events.push(
            doseEvent(d, {
              id: `perf-${n++}`,
              pumpId,
              actualMl: 1,
              source: k % 4 === 0 ? 'catchup' : k % 4 === 1 ? 'manual' : 'schedule',
            }),
          );
        }
      }
    }
    expect(events).toHaveLength(9000);

    const start = performance.now();
    const months = buildMonthHierarchy(events);
    const buckets = buildHistoryBuckets(events, 90, now);
    // Screen-default expansion: newest month/week/day.
    const rows = flattenHierarchy(months, (kind, key) => {
      if (kind === 'month') return key === months[0].key;
      if (kind === 'week') return key === months[0].weeks[0].key;
      return key === months[0].weeks[0].days[0].key;
    });
    const elapsed = performance.now() - start;

    expect(months.length).toBeGreaterThanOrEqual(3);
    expect(buckets).toHaveLength(90);
    // Collapsed sections cost one row each; only the screen-default-expanded
    // newest month/week/day render deeper — its newest day holds 100 events,
    // so the total stays ~O(sections) + O(expanded), never O(9000).
    expect(rows.length).toBeLessThan(200);
    expect(elapsed).toBeLessThan(1000);
  });
});
