import type {
  CatchupQueueItem,
  DoseQueueItem,
  DoseSchedule,
} from '@reef/shared';
import { getNextDueDate } from '@reef/shared';

/**
 * Dashboard "Next Dose" model — a pure merge of the scheduler's next
 * occurrence per enabled schedule with the engine's FIFO queue (from
 * /api/status's queueItems). The device owns all truth here; this only
 * decides which of those events the user sees first and what action (if
 * any) the detail sheet can offer against it.
 */

export type NextDose =
  | { kind: 'scheduled'; schedule: DoseSchedule; date: Date }
  | {
      kind: 'queued';
      item: DoseQueueItem;
      /** 1-based FIFO position (index in queueItems + 1). */
      position: number;
      estimatedFireAt: Date;
      /**
       * For catch-up items, the missed-dose record a cancel request must
       * reference — recovered by matching the queue item against
       * catchupQueue.queued (queueItems don't carry the id). Null when no
       * unambiguous match exists.
       */
      missedDoseId: string | null;
    };

/**
 * Recover the missedDoseId for a queued catch-up. queueItems and
 * catchupQueue.queued are two views of the same server snapshot, so the
 * estimatedFireAt ISO strings match exactly. A match is only trusted when
 * it is unique — no match or an ambiguous tie yields null.
 */
export function matchCatchupMissedId(
  item: DoseQueueItem,
  catchupQueued: CatchupQueueItem[],
): string | null {
  const matches = catchupQueued.filter(
    (c) =>
      c.pumpId === item.pumpId &&
      c.estimatedFireAt != null &&
      c.estimatedFireAt === item.estimatedFireAt,
  );
  return matches.length === 1 ? matches[0].missedDoseId : null;
}

/** The earliest upcoming dose across enabled schedules and the engine queue. */
export function resolveNextDose(
  schedules: DoseSchedule[],
  queueItems: DoseQueueItem[],
  catchupQueued: CatchupQueueItem[],
  now: Date,
): NextDose | null {
  let best: NextDose | null = null;
  let bestTime = Infinity;

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const date = getNextDueDate(schedule, now);
    if (!date) continue;
    const t = date.getTime();
    if (t < bestTime) {
      bestTime = t;
      best = { kind: 'scheduled', schedule, date };
    }
  }

  queueItems.forEach((item, index) => {
    const t = new Date(item.estimatedFireAt).getTime();
    if (Number.isNaN(t)) return;
    if (t < bestTime) {
      bestTime = t;
      best = {
        kind: 'queued',
        item,
        position: index + 1,
        estimatedFireAt: new Date(t),
        missedDoseId:
          item.source === 'catchup'
            ? matchCatchupMissedId(item, catchupQueued)
            : null,
      };
    }
  });

  return best;
}

/** Long-form source line for the detail sheet. */
export function nextDoseSourceLabel(nextDose: NextDose): string {
  if (nextDose.kind === 'scheduled') {
    return `Scheduled — ${nextDose.schedule.startTime}`;
  }
  switch (nextDose.item.source) {
    case 'catchup':
      return 'Catch-up (queued)';
    case 'manual':
      return 'Manual (queued)';
    case 'schedule':
      return 'Scheduled (queued)';
    default:
      return `${
        nextDose.item.source.charAt(0).toUpperCase() +
        nextDose.item.source.slice(1)
      } (queued)`;
  }
}

/** Short pill text for the card. */
export function nextDoseSourceTag(nextDose: NextDose): string {
  if (nextDose.kind === 'scheduled') return 'SCHEDULED';
  if (nextDose.item.source === 'catchup') return 'CATCH-UP';
  if (nextDose.item.source === 'manual') return 'MANUAL';
  return 'QUEUED';
}

/**
 * Declarative action plan the detail sheet renders from. 'skip' maps to
 * POST /pumps/:id/skip-next; 'remove' withdraws a queued dose via the
 * cancel endpoint for its flavour; 'remove-unavailable' hides the remove
 * button (queued catch-up with no recoverable missedDoseId, or a queued
 * dose whose source has no withdraw path here).
 */
export type NextDoseActionPlan =
  | { kind: 'skip' }
  | { kind: 'remove'; cancel: 'manual'; jobId: string }
  | { kind: 'remove'; cancel: 'catchup'; missedDoseId: string }
  | { kind: 'remove-unavailable' };

export function nextDoseActionPlan(nextDose: NextDose): NextDoseActionPlan {
  if (nextDose.kind === 'scheduled') return { kind: 'skip' };
  if (nextDose.item.source === 'manual') {
    return { kind: 'remove', cancel: 'manual', jobId: nextDose.item.id };
  }
  if (nextDose.item.source === 'catchup') {
    if (nextDose.missedDoseId) {
      return {
        kind: 'remove',
        cancel: 'catchup',
        missedDoseId: nextDose.missedDoseId,
      };
    }
    return { kind: 'remove-unavailable' };
  }
  return { kind: 'remove-unavailable' };
}
