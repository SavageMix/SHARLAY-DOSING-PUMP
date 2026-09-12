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
 * Forced-decision mode: the page cannot be left while any entry still needs
 * an explicit decision. Voluntary visits (forced=false) may always leave.
 */
export function canCloseCatchups(forced: boolean, pendingCount: number): boolean {
  return !forced || pendingCount === 0;
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
}

/**
 * QUEUED / FIRING section model — a faithful, passive view of
 * /api/status's catchupQueue. No local state is mixed in, which is what
 * makes the section survive a full page refresh identically.
 */
export function buildQueueSection(
  firing: CatchupQueueItem | null,
  queued: CatchupQueueItem[],
): QueueSectionModel {
  return {
    firing: firing ?? null,
    queued: Array.isArray(queued) ? [...queued] : [],
  };
}

export type ResolvedRow =
  | {
      kind: 'fired';
      key: string;
      pumpId: PumpId;
      /** Wall-clock time of the original missed slot. */
      missedSlotIso: string | null;
      /** When the catch-up actually fired. */
      firedAtIso: string;
      actualMl: number | null;
      status: 'completed' | 'failed' | 'interrupted';
      error: string | null;
    }
  | {
      kind: 'skipped';
      key: string;
      pumpId: PumpId;
      missedSlotIso: string;
      volumeMl: number;
      reason: 'skipped' | 'expired';
    };

/**
 * RESOLVED (last 24h) section. Fired catch-ups come from /api/history
 * (source 'catchup', already time-windowed by the query, enriched with the
 * missed slot); skipped/expired entries from /api/missed-doses/resolved.
 * Entries represented by a fired event take precedence over the terminal
 * missed row, so nothing appears twice. Newest first.
 */
export function buildResolvedRows(
  firedEvents: DoseEvent[],
  resolvedMisses: MissedDose[],
): ResolvedRow[] {
  const firedByMissedId = new Map<string, DoseEvent>();
  for (const e of firedEvents) {
    if (e.source === 'catchup' && e.missedDoseId) {
      firedByMissedId.set(e.missedDoseId, e);
    }
  }

  const rows: ResolvedRow[] = [];
  for (const e of firedEvents) {
    if (e.source !== 'catchup') continue;
    rows.push({
      kind: 'fired',
      key: `fired-${e.id}`,
      pumpId: e.pumpId,
      missedSlotIso: (e as DoseEvent & { missedDoseScheduledFor?: string | null })
        .missedDoseScheduledFor ?? null,
      firedAtIso: e.startedAt,
      actualMl: e.actualMl,
      status:
        e.status === 'completed' || e.status === 'failed' || e.status === 'interrupted'
          ? e.status
          : 'failed',
      error: e.error,
    });
  }
  for (const m of resolvedMisses) {
    if (firedByMissedId.has(m.id)) continue; // already shown as a fired row
    if (m.status !== 'dismissed' && m.status !== 'expired') continue;
    rows.push({
      kind: 'skipped',
      key: `skipped-${m.id}`,
      pumpId: m.pumpId,
      missedSlotIso: m.scheduledFor,
      volumeMl: m.volumeMl,
      reason: m.status === 'expired' ? 'expired' : 'skipped',
    });
  }

  const timeOf = (r: ResolvedRow) =>
    r.kind === 'fired' ? r.firedAtIso : r.missedSlotIso;
  return rows.sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
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
