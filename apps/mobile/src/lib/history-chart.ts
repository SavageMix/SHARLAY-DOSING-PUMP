import type { DoseEvent, PumpId } from '@reef/shared';

/**
 * Pure bucketing for the History chart. Extracted from HistoryChart so the
 * range/granularity/filter rules are directly testable without a component
 * harness. The device is the source of data; this only reshapes the same
 * payload the events list renders.
 *
 * Rules:
 * - 1 day  → hourly buckets (00–23) for the device-local calendar day.
 * - 7/30 d → daily buckets for the device-local calendar days today-(N-1)…
 *   today. The range START is shared with the events-list filter (exported
 *   below) so bucket sums and the list can never disagree — one definition
 *   of "in the last N days" for the whole screen.
 * - Bucket boundaries are device-local wall clock (never UTC date-slicing —
 *   a dose at 00:30 local belongs to today).
 * - Totals sum delivered volume (status 'completed', actualMl != null) from
 *   ALL sources (schedule, catchup, manual, prime). Failed/interrupted doses
 *   never inflate totals but flag their bucket so the chart can mark them —
 *   a day with a failed dose must be visible, not silently zero.
 * - Empty buckets render as zero, never as gaps: a missed day is real
 *   information.
 */

export interface HistoryBucket {
  /** Stable identity (local date, or local date + hour). */
  key: string;
  /** X-axis label, device-local. */
  label: string;
  /** Summed delivered mL per pump for this bucket. */
  values: Record<PumpId, number>;
  /**
   * True when a failed or interrupted dose landed in this bucket. Excluded
   * from `values`, surfaced separately so a bad day can't read as a quiet
   * zero-volume day.
   */
  failed: boolean;
}

const PUMPS: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Device-local calendar date key — NOT toISOString() (that slices UTC). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function zeroValues(): Record<PumpId, number> {
  return { alk: 0, ca: 0, no3: 0, po4: 0 };
}

function accumulate(bucket: HistoryBucket, event: DoseEvent): void {
  if (event.status === 'failed' || event.status === 'interrupted') {
    bucket.failed = true;
    return; // honest under-delivery: visible, never counted as delivered.
  }
  if (event.status !== 'completed' || event.actualMl === null) return;
  bucket.values[event.pumpId] += event.actualMl;
}

export function historyChartTitle(days: number): string {
  if (days === 1) return 'Today, hourly';
  return `Last ${days} days`;
}

/**
 * Range start shared by the chart AND the events-list filter: start of the
 * device-local calendar day (today for 1d, today-(N-1) for 7/30d). One
 * definition of "the last N days" for the whole screen, so the graph totals
 * and the list can never disagree at the window edge.
 */
export function historyRangeStart(days: number, now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (days > 1) start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/**
 * Bucket `events` for the chart. When a specific pump is selected the caller
 * pre-filters the events (same data, subset) — this function stays pump-
 * agnostic so the "All" stacked view and the single-pump view share one path.
 *
 * `date` (a localDateKey) is the drill-down override: when set, the chart
 * shows that calendar day's hourly buckets regardless of `days` — the parent
 * range is kept so "Back to Last N days" knows where to return.
 */
export function buildHistoryBuckets(
  events: DoseEvent[],
  days: number,
  now: Date,
  date?: string | null,
): HistoryBucket[] {
  if (date) return buildHourlyBuckets(events, date);
  if (days === 1) return buildHourlyBuckets(events, localDateKey(now));
  return buildDailyBuckets(events, days, now);
}

/** Parse a localDateKey back into a device-local Date (local midnight). */
export function parseLocalDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 'Tue 30 Sep' — the day-section header / drill title format. */
export function formatDayHeaderLabel(key: string): string {
  return parseLocalDateKey(key).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** Chart title while drilled into a specific day. */
export function historyChartDrillTitle(date: string): string {
  return `${formatDayHeaderLabel(date)}, hourly`;
}

function buildHourlyBuckets(events: DoseEvent[], dayKey: string): HistoryBucket[] {
  const buckets: HistoryBucket[] = [];
  for (let h = 0; h < 24; h++) {
    buckets.push({
      key: `${dayKey} ${pad2(h)}`,
      label: pad2(h),
      values: zeroValues(),
      failed: false,
    });
  }
  for (const event of events) {
    const d = new Date(event.startedAt);
    if (Number.isNaN(d.getTime())) continue;
    if (localDateKey(d) !== dayKey) continue;
    accumulate(buckets[d.getHours()], event);
  }
  return buckets;
}

function buildDailyBuckets(
  events: DoseEvent[],
  days: number,
  now: Date,
): HistoryBucket[] {
  const start = historyRangeStart(days, now);
  const buckets: HistoryBucket[] = [];
  const byKey = new Map<string, HistoryBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    const bucket: HistoryBucket = {
      key,
      label: d.toLocaleDateString(undefined, {
        month: 'numeric',
        day: 'numeric',
      }),
      values: zeroValues(),
      failed: false,
    };
    buckets.push(bucket);
    byKey.set(key, bucket);
  }
  for (const event of events) {
    const t = new Date(event.startedAt).getTime();
    // Same range start as the events-list filter — bucket sums and the list
    // always agree.
    if (Number.isNaN(t) || t < start) continue;
    const bucket = byKey.get(localDateKey(new Date(t)));
    if (bucket) accumulate(bucket, event);
  }
  return buckets;
}

/** Total stacked value of a bucket, respecting the legend's visibility toggles. */
export function bucketTotal(
  bucket: HistoryBucket,
  visible: Record<PumpId, boolean>,
): number {
  return PUMPS.reduce(
    (sum, pumpId) => (visible[pumpId] ? sum + bucket.values[pumpId] : sum),
    0,
  );
}

/**
 * Day-grouped event list, sharing the chart's exact local-midnight day
 * definition (localDateKey). Groups are reverse-chronological (newest day
 * first) and events within a group are reverse-chronological — the same
 * order the flat list showed. The header summary deliberately uses the SAME
 * delivered-mL rule as the chart buckets (completed + actualMl), so a day's
 * "96.0 mL delivered" always equals that day's bar total.
 */
export interface HistoryDayGroup {
  /** localDateKey — stable identity and sort order. */
  key: string;
  /** Header label, e.g. 'Tue 30 Sep' — device-local. */
  label: string;
  /** All events of the day, newest first. */
  events: DoseEvent[];
  /** Total events in the day, every status (this is a list, not a tally). */
  eventCount: number;
  /** Delivered mL — completed events with actualMl, same rule as the chart. */
  deliveredMl: number;
  /** failed + interrupted count — badges the header so a bad day is
      visible without expanding. */
  failedCount: number;
}

export function groupEventsByDay(events: DoseEvent[]): HistoryDayGroup[] {
  const byKey = new Map<string, DoseEvent[]>();
  for (const event of events) {
    const t = new Date(event.startedAt).getTime();
    if (Number.isNaN(t)) continue;
    const key = localDateKey(new Date(t));
    const list = byKey.get(key) ?? [];
    list.push(event);
    byKey.set(key, list);
  }

  const groups: HistoryDayGroup[] = [];
  for (const [key, list] of byKey) {
    // Newest first within the day; localDateKey strings also sort
    // lexicographically into chronological order across days.
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    let deliveredMl = 0;
    let failedCount = 0;
    for (const e of list) {
      if (e.status === 'failed' || e.status === 'interrupted') {
        failedCount += 1;
      } else if (e.status === 'completed' && e.actualMl !== null) {
        deliveredMl += e.actualMl;
      }
    }
    groups.push({
      key,
      label: formatDayHeaderLabel(key),
      events: list,
      eventCount: list.length,
      deliveredMl,
      failedCount,
    });
  }
  groups.sort((a, b) => b.key.localeCompare(a.key));
  return groups;
}
