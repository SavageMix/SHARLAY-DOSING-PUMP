import type {
  CatchupQueueItem,
  DoseEvent,
  MissedDose,
  PumpId,
} from '@reef/shared';

/**
 * Pure builders for the Catch-ups page, the Dashboard redirect, and the
 * Settings status row. Everything here derives from API payloads — the
 * device is the source of truth, so a remount (page refresh) fed the same
 * /api/status produces the exact same model (see the remount test).
 */

/** A pending entry blocks (forced flow) when it has no snooze or a lapsed one. */
export function isBlockingMissedDose(missed: MissedDose, now: number): boolean {
  if (missed.status !== 'pending') return false;
  if (!missed.deferredUntil) return true;
  const t = new Date(missed.deferredUntil).getTime();
  return Number.isNaN(t) || t <= now;
}

/**
 * Exiting the Catch-ups page (any mode) never dismisses anything — entries
 * stay pending and the decision follows the user (Dashboard banner +
 * Settings row keep counting them). A forced-mode exit is snoozed for 1h so
 * leaving doesn't immediately re-trap the user on the next poll; voluntary
 * exits leave the entries fully blocking so the alarm stays loud.
 */
export function shouldSnoozeOnExit(forced: boolean): boolean {
  return forced;
}

export type CatchupsTone = 'amber' | 'aqua' | 'calm';

export interface CatchupsSummary {
  tone: CatchupsTone;
  /** Short status line for the Settings row, e.g. "3 need your decision". */
  text: string;
  /** Total items needing attention (drives visibility/tone priority). */
  pendingCount: number;
  firingCount: number;
  queuedCount: number;
}

/**
 * Settings-row summary. Priority: pending decisions (amber) > live queue
 * (aqua) > calm. The row itself is always present — "all caught up" is the
 * resting state.
 */
export function buildCatchupsSummary(
  pendingCount: number,
  firing: CatchupQueueItem | null,
  queuedCount: number,
): CatchupsSummary {
  const firingCount = firing ? 1 : 0;
  if (pendingCount > 0) {
    return {
      tone: 'amber',
      text:
        pendingCount === 1
          ? '1 needs your decision'
          : `${pendingCount} need your decision`,
      pendingCount,
      firingCount,
      queuedCount,
    };
  }
  if (firingCount > 0 || queuedCount > 0) {
    const parts: string[] = [];
    if (firingCount > 0) parts.push('1 firing');
    if (queuedCount > 0)
      parts.push(`${queuedCount} queued`);
    return {
      tone: 'aqua',
      text: parts.join(', '),
      pendingCount,
      firingCount,
      queuedCount,
    };
  }
  return {
    tone: 'calm',
    text: 'all caught up',
    pendingCount: 0,
    firingCount: 0,
    queuedCount: 0,
  };
}

export interface QueueSectionModel {
  firing: CatchupQueueItem | null;
  queued: CatchupQueueItem[];
  /**
   * Confirmed catch-ups not yet terminal (in flight + queued + scheduled
   * ahead). Lets the UI show drain progress during multi-hour drains even
   * when nothing is in the engine queue yet. Defaults to 0 so older device
   * builds (which omit the field) keep working.
   */
  remaining: number;
  /** Earliest upcoming fire time, or null when nothing is scheduled. */
  nextFireAt: string | null;
}

/**
 * QUEUED / FIRING section model — a faithful, passive view of
 * /api/status's catchupQueue. No local state is mixed in, which is what
 * makes the section survive a full page refresh identically.
 */
export function buildQueueSection(
  firing: CatchupQueueItem | null,
  queued: CatchupQueueItem[],
  drain?: { remaining: number; nextFireAt: string | null },
): QueueSectionModel {
  return {
    firing: firing ?? null,
    queued: Array.isArray(queued) ? [...queued] : [],
    remaining: drain?.remaining ?? 0,
    nextFireAt: drain?.nextFireAt ?? null,
  };
}

/**
 * RESOLVED window: the section answers "what happened while I was away", so
 * a weekend-incident must still be visible days later. Endpoint already
 * accepts sinceHours; the matching /api/history enrichment fetch uses
 * RESOLVED_WINDOW_DAYS.
 */
export const RESOLVED_WINDOW_HOURS = 168; // 7 days
export const RESOLVED_WINDOW_DAYS = 7;

export type ResolvedOutcome = 'delivered' | 'skipped' | 'expired' | 'failed' | 'cancelled';

export interface ResolvedSlotRow {
  key: string;
  outcome: ResolvedOutcome;
  /** Wall-clock time of the original missed slot. */
  missedSlotIso: string;
  /**
   * mL figure shown on the row: actualMl when the dose event is matched,
   * otherwise the requested volumeMl.
   */
  ml: number;
  /**
   * False when the entry is 'completed' but its dose event aged out of the
   * /api/history window — the UI labels this "X mL requested" instead of
   * "delivered X mL" so we never claim a delivery we can't confirm.
   */
  deliveredKnown: boolean;
  error: string | null;
}

export interface ResolvedPumpGroup {
  pumpId: PumpId;
  deliveredCount: number;
  /** Includes expired entries (visually labelled 'expired'). */
  skippedCount: number;
  failedCount: number;
  /** Withdrawn confirmed catch-ups ("removed from queue") — never dosed. */
  cancelledCount: number;
  /** Sum of delivered rows' mL. */
  totalMl: number;
  /** Chronological (oldest missed slot first). */
  rows: ResolvedSlotRow[];
}

/**
 * RESOLVED (last 24h) section. /api/missed-doses/resolved is the PRIMARY
 * source — every terminal entry it returns renders a row, so a dismissed
 * (or completed-but-aged-out) entry can never silently vanish. Dose events
 * from /api/history only ENRICH a 'completed' entry (actualMl, error,
 * deliveredKnown); they never gate whether a row exists. This previously
 * worked the other way round and dropped dismissed rows from the UI.
 *
 * Always returns one group per pump in `pumpOrder`, even with zero rows, so
 * the section keeps its four top-level lines regardless of outage size.
 */
export function buildResolvedGroups(
  firedEvents: DoseEvent[],
  resolvedMisses: MissedDose[],
  pumpOrder: PumpId[],
): ResolvedPumpGroup[] {
  const firedByMissedId = new Map<string, DoseEvent>();
  for (const e of firedEvents) {
    if (e.source === 'catchup' && e.missedDoseId) {
      firedByMissedId.set(e.missedDoseId, e);
    }
  }

  const groups = new Map<PumpId, ResolvedPumpGroup>();
  for (const pumpId of pumpOrder) {
    groups.set(pumpId, {
      pumpId,
      deliveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      totalMl: 0,
      rows: [],
    });
  }

  for (const m of resolvedMisses) {
    const group = groups.get(m.pumpId);
    if (!group) continue;
    if (
      m.status !== 'completed' &&
      m.status !== 'dismissed' &&
      m.status !== 'expired' &&
      m.status !== 'failed' &&
      m.status !== 'interrupted' &&
      m.status !== 'cancelled'
    ) {
      continue; // non-terminal entries never render here
    }
    const event =
      m.status === 'completed' || m.status === 'failed' || m.status === 'interrupted'
        ? firedByMissedId.get(m.id)
        : undefined;
    let row: ResolvedSlotRow;
    if (m.status === 'completed') {
      group.deliveredCount += 1;
      const actualMl = event?.actualMl ?? null;
      if (actualMl != null) group.totalMl += actualMl;
      row = {
        key: `resolved-${m.id}`,
        outcome: 'delivered',
        missedSlotIso: m.scheduledFor,
        ml: actualMl ?? m.volumeMl,
        deliveredKnown: event != null && actualMl != null,
        error: event?.error ?? null,
      };
    } else if (m.status === 'dismissed') {
      group.skippedCount += 1;
      row = {
        key: `resolved-${m.id}`,
        outcome: 'skipped',
        missedSlotIso: m.scheduledFor,
        ml: m.volumeMl,
        deliveredKnown: false,
        error: null,
      };
    } else if (m.status === 'expired') {
      group.skippedCount += 1;
      row = {
        key: `resolved-${m.id}`,
        outcome: 'expired',
        missedSlotIso: m.scheduledFor,
        ml: m.volumeMl,
        deliveredKnown: false,
        error: null,
      };
    } else if (m.status === 'cancelled') {
      // User withdrew a confirmed catch-up before it fired — never dosed.
      group.cancelledCount += 1;
      row = {
        key: `resolved-${m.id}`,
        outcome: 'cancelled',
        missedSlotIso: m.scheduledFor,
        ml: m.volumeMl,
        deliveredKnown: false,
        error: null,
      };
    } else {
      group.failedCount += 1;
      const actualMl = event?.actualMl ?? null;
      row = {
        key: `resolved-${m.id}`,
        outcome: 'failed',
        missedSlotIso: m.scheduledFor,
        ml: actualMl ?? m.volumeMl,
        deliveredKnown: event != null && actualMl != null,
        error: event?.error ?? null,
      };
    }
    group.rows.push(row);
  }

  return pumpOrder.map((pumpId) => {
    const group = groups.get(pumpId)!;
    return { ...group, rows: [...group.rows].sort((a, b) => a.missedSlotIso.localeCompare(b.missedSlotIso)) };
  });
}

export interface ResolvedDayGroup {
  /** Start-of-local-day ms — stable grouping identity, not for display. */
  dayKey: number;
  /** 'Today' / 'Yesterday' / 'Sat 5 Sep' — device-local wall clock. */
  label: string;
  /** Chronological (oldest missed slot first) within the day. */
  rows: ResolvedSlotRow[];
}

function startOfLocalDayMs(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Day label for a timestamp, sliced on DEVICE-LOCAL wall-clock boundaries
 * (never UTC date-slicing — the timezone lesson from the scheduler applies
 * here too: the user reads these labels against their own wall clock).
 */
export function dayLabelFor(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffDays = Math.round(
    (startOfLocalDayMs(now) - startOfLocalDayMs(t)) / 86_400_000,
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Group an expanded pump card's rows under day headers: newest day first,
 * rows chronological within each day. Local-day sliced (see dayLabelFor).
 */
export function groupResolvedByDay(
  rows: ResolvedSlotRow[],
  now: number,
): ResolvedDayGroup[] {
  const byDay = new Map<number, ResolvedSlotRow[]>();
  for (const r of rows) {
    const t = new Date(r.missedSlotIso).getTime();
    if (Number.isNaN(t)) continue;
    const key = startOfLocalDayMs(t);
    const list = byDay.get(key) ?? [];
    list.push(r);
    byDay.set(key, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([dayKey, dayRows]) => ({
      dayKey,
      label: dayLabelFor(dayRows[0].missedSlotIso, now),
      rows: [...dayRows].sort((a, b) =>
        a.missedSlotIso.localeCompare(b.missedSlotIso),
      ),
    }));
}

/** Group pending entries per pump, pump order stable (alk → ca → no3 → po4). */
export function groupMissedByPump<T extends { pumpId: PumpId }>(
  entries: T[],
  pumpOrder: PumpId[],
): Array<{ pumpId: PumpId; entries: T[] }> {
  const byPump = new Map<PumpId, T[]>();
  for (const e of entries) {
    const list = byPump.get(e.pumpId) ?? [];
    list.push(e);
    byPump.set(e.pumpId, list);
  }
  const groups: Array<{ pumpId: PumpId; entries: T[] }> = [];
  for (const pumpId of pumpOrder) {
    const list = byPump.get(pumpId);
    if (list && list.length > 0) groups.push({ pumpId, entries: list });
  }
  return groups;
}

/**
 * Split the missed-doses list (fetched with includeConfirmed) into the two
 * actionable states. Pending entries need a dose/skip decision; confirmed
 * ones are queued catch-ups the user can still withdraw. Everything else is
 * terminal and belongs to the RESOLVED section, never here.
 */
export function splitPendingAndQueued(missedDoses: MissedDose[]): {
  pending: MissedDose[];
  queued: MissedDose[];
} {
  const pending: MissedDose[] = [];
  const queued: MissedDose[] = [];
  for (const m of missedDoses) {
    if (m.status === 'pending') pending.push(m);
    else if (m.status === 'confirmed') queued.push(m);
  }
  return { pending, queued };
}
