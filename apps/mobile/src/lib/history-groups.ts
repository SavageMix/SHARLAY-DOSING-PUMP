import type { DoseEvent } from '@reef/shared';
import {
  formatDayHeaderLabel,
  groupEventsByDay,
  localDateKey,
  type HistoryDayGroup,
} from './history-chart';

/**
 * Month → week → day hierarchy for the 90-day History view. Built FROM the
 * chart's day groups (groupEventsByDay), so:
 * - the day definition is the exact same localDateKey local-midnight split
 *   the chart buckets by;
 * - month/week/day sums are mutually consistent by construction (parents
 *   sum their children), and equal the chart bucket totals;
 * - the red failed badge bubbles up: a day with failures badges its week
 *   and month headers too.
 *
 * Weeks run Monday–Sunday, device-local. Everything is reverse-chronological
 * (newest month first; within a month, newest week first; within a week,
 * newest day first) — the same order the flat and per-day lists use.
 */

export interface HistoryWeekGroup {
  /** Monday's localDateKey — stable identity and chronological sort order. */
  key: string;
  /** '22–28 Sep' (cross-month: '29 Sep–5 Oct'). */
  label: string;
  /** Newest day first. */
  days: HistoryDayGroup[];
  eventCount: number;
  /** Completed mL — same rule as the chart buckets and day headers. */
  deliveredMl: number;
  /** Sum of the days' failed+interrupted counts — badges the week header. */
  failedCount: number;
}

export interface HistoryMonthGroup {
  /** '2026-09'. */
  key: string;
  /** 'September 2026'. */
  label: string;
  /** Newest week first. */
  weeks: HistoryWeekGroup[];
  eventCount: number;
  deliveredMl: number;
  /** Bubbled-up from weeks/days — badges the month header. */
  failedCount: number;
}

/** Monday (local midnight) of the week containing `d`. Weeks: Mon–Sun. */
export function mondayOfWeek(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // JS Sun=0 → shift so Mon=0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
}

/** '22–28 Sep', or '29 Sep–5 Oct' when the week straddles a month. */
export function weekLabel(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (monday.getMonth() === sunday.getMonth()) {
    return `${monday.getDate()}–${sunday.getDate()} ${monday.toLocaleDateString(undefined, { month: 'short' })}`;
  }
  return `${fmt(monday)}–${fmt(sunday)}`;
}

export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7); // 'YYYY-MM-DD' → 'YYYY-MM'
}

export function monthLabelOf(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

/** Group chart day-groups into weeks, then weeks into months. */
export function groupDaysByMonth(days: HistoryDayGroup[]): HistoryMonthGroup[] {
  const months = new Map<string, HistoryMonthGroup>();
  for (const day of days) {
    // newest-first within each week; weeks and months are sorted afterwards
    const monday = mondayOfWeek(new Date(day.key + 'T00:00:00'));
    const weekKey = localDateKey(monday);
    const monthKey = monthKeyOf(day.key);
    let month = months.get(monthKey);
    if (!month) {
      month = {
        key: monthKey,
        label: monthLabelOf(monthKey),
        weeks: [],
        eventCount: 0,
        deliveredMl: 0,
        failedCount: 0,
      };
      months.set(monthKey, month);
    }
    let week = month.weeks.find((w) => w.key === weekKey);
    if (!week) {
      week = {
        key: weekKey,
        label: weekLabel(monday),
        days: [],
        eventCount: 0,
        deliveredMl: 0,
        failedCount: 0,
      };
      month.weeks.push(week);
    }
    week.days.push(day);
    week.eventCount += day.eventCount;
    week.deliveredMl += day.deliveredMl;
    week.failedCount += day.failedCount;
    month.eventCount += day.eventCount;
    month.deliveredMl += day.deliveredMl;
    month.failedCount += day.failedCount;
  }
  // Newest first at every level. localDateKey / month keys sort
  // lexicographically into reverse-chronological order when reversed.
  const result = [...months.values()].sort((a, b) =>
    b.key.localeCompare(a.key),
  );
  for (const month of result) {
    month.weeks.sort((a, b) => b.key.localeCompare(a.key));
  }
  return result;
}

/** Full hierarchy from raw events — the 90d list model. */
export function buildMonthHierarchy(
  events: DoseEvent[],
): HistoryMonthGroup[] {
  return groupDaysByMonth(groupEventsByDay(events));
}

/**
 * Flatten the hierarchy into renderable rows, keeping ONLY expanded
 * sections' children — collapsed sections cost a single header row, so a
 * 90-day × 4-pump dataset renders in well under a hundred rows until the
 * user expands deeper.
 */
export type HistoryRow =
  | { kind: 'month'; key: string; group: HistoryMonthGroup }
  | { kind: 'week'; key: string; group: HistoryWeekGroup }
  | { kind: 'day'; key: string; group: HistoryDayGroup }
  | { kind: 'event'; key: string; event: DoseEvent };

export function flattenHierarchy(
  months: HistoryMonthGroup[],
  isExpanded: (kind: 'month' | 'week' | 'day', key: string) => boolean,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const month of months) {
    rows.push({ kind: 'month', key: `month:${month.key}`, group: month });
    if (!isExpanded('month', month.key)) continue;
    for (const week of month.weeks) {
      rows.push({ kind: 'week', key: `week:${week.key}`, group: week });
      if (!isExpanded('week', week.key)) continue;
      for (const day of week.days) {
        rows.push({ kind: 'day', key: `day:${day.key}`, group: day });
        if (!isExpanded('day', day.key)) continue;
        for (const event of day.events) {
          rows.push({ kind: 'event', key: `event:${event.id}`, event });
        }
      }
    }
  }
  return rows;
}

// Re-export so the screen imports day-group helpers from one place.
export { formatDayHeaderLabel };
