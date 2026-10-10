import { describe, expect, it } from 'vitest';
import type {
  CatchupQueueItem,
  DoseQueueItem,
  DoseSchedule,
} from '@reef/shared';
import {
  matchCatchupMissedId,
  nextDoseActionPlan,
  nextDoseSourceLabel,
  nextDoseSourceTag,
  resolveNextDose,
} from './next-dose';

const NOW = new Date('2026-09-14T10:00:00');

function schedule(partial: Partial<DoseSchedule> = {}): DoseSchedule {
  return {
    id: 'sched-1',
    pumpId: 'alk',
    volumeMl: 1.5,
    timesPerDay: 1,
    startTime: '14:30',
    repeatEveryNDays: 1,
    enabled: true,
    lastRunAt: null,
    ...partial,
  };
}

function queueItem(partial: Partial<DoseQueueItem> = {}): DoseQueueItem {
  return {
    id: 'job-1',
    pumpId: 'ca',
    amountMl: 2,
    source: 'manual',
    estimatedFireAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    ...partial,
  };
}

function catchupQueued(
  partial: Partial<CatchupQueueItem> = {},
): CatchupQueueItem {
  return {
    pumpId: 'ca',
    missedDoseId: 'missed-1',
    missedDoseScheduledFor: new Date(
      NOW.getTime() - 2 * 60 * 60 * 1000,
    ).toISOString(),
    estimatedFireAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    ...partial,
  };
}

describe('nextDoseSourceLabel', () => {
  it('labels a scheduled dose with its start time', () => {
    const next = resolveNextDose([schedule()], [], [], NOW);
    expect(next?.kind).toBe('scheduled');
    if (next?.kind !== 'scheduled') return;
    expect(nextDoseSourceLabel(next)).toBe('Scheduled — 14:30');
  });

  it('labels queued catch-up, manual and schedule sources', () => {
    const catchup = resolveNextDose(
      [],
      [queueItem({ id: 'c1', source: 'catchup' })],
      [],
      NOW,
    );
    const manual = resolveNextDose([], [queueItem({ id: 'm1' })], [], NOW);
    const sched = resolveNextDose(
      [],
      [queueItem({ id: 's1', source: 'schedule' })],
      [],
      NOW,
    );
    if (catchup?.kind !== 'queued' || manual?.kind !== 'queued' || sched?.kind !== 'queued')
      throw new Error('expected queued doses');
    expect(nextDoseSourceLabel(catchup)).toBe('Catch-up (queued)');
    expect(nextDoseSourceLabel(manual)).toBe('Manual (queued)');
    expect(nextDoseSourceLabel(sched)).toBe('Scheduled (queued)');
  });
});

describe('nextDoseSourceTag', () => {
  it('tags scheduled, catch-up and manual doses', () => {
    const scheduled = resolveNextDose([schedule()], [], [], NOW);
    const catchup = resolveNextDose(
      [],
      [queueItem({ id: 'c1', source: 'catchup' })],
      [],
      NOW,
    );
    const manual = resolveNextDose([], [queueItem({ id: 'm1' })], [], NOW);
    if (scheduled?.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(nextDoseSourceTag(scheduled)).toBe('SCHEDULED');
    if (catchup?.kind !== 'queued' || manual?.kind !== 'queued')
      throw new Error('expected queued');
    expect(nextDoseSourceTag(catchup)).toBe('CATCH-UP');
    expect(nextDoseSourceTag(manual)).toBe('MANUAL');
  });
});

describe('resolveNextDose', () => {
  it('picks the queued item when it fires before the scheduled dose', () => {
    // Scheduled: today 14:30 (4.5h out). Queued: 1h out.
    const next = resolveNextDose(
      [schedule()],
      [queueItem()],
      [],
      NOW,
    );
    expect(next?.kind).toBe('queued');
    if (next?.kind !== 'queued') return;
    expect(next.item.id).toBe('job-1');
    expect(next.position).toBe(1);
  });

  it('picks the scheduled dose when it fires before the queued item', () => {
    // Queued: 6h out — after the 14:30 scheduled occurrence.
    const next = resolveNextDose(
      [schedule()],
      [
        queueItem({
          estimatedFireAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      [],
      NOW,
    );
    expect(next?.kind).toBe('scheduled');
    if (next?.kind !== 'scheduled') return;
    expect(next.schedule.id).toBe('sched-1');
  });

  it('reports 1-based FIFO positions across the queue', () => {
    const next = resolveNextDose(
      [],
      [queueItem({ id: 'job-1' }), queueItem({ id: 'job-2' })],
      [],
      NOW,
    );
    // job-1 fires first (same estimatedFireAt, FIFO order wins the tie)
    expect(next?.kind).toBe('queued');
    if (next?.kind !== 'queued') return;
    expect(next.position).toBe(1);
    expect(next.item.id).toBe('job-1');
  });

  it('ignores disabled schedules and invalid queue timestamps', () => {
    expect(
      resolveNextDose([schedule({ enabled: false })], [], [], NOW),
    ).toBeNull();
    expect(
      resolveNextDose(
        [],
        [queueItem({ estimatedFireAt: 'not-a-date' })],
        [],
        NOW,
      ),
    ).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveNextDose([], [], [], NOW)).toBeNull();
  });
});

describe('matchCatchupMissedId', () => {
  it('recovers the missedDoseId on pumpId + estimatedFireAt match', () => {
    const item = queueItem({ id: 'c1', source: 'catchup' });
    expect(matchCatchupMissedId(item, [catchupQueued()])).toBe('missed-1');
  });

  it('returns null when nothing matches', () => {
    const item = queueItem({ id: 'c1', source: 'catchup' });
    expect(matchCatchupMissedId(item, [])).toBeNull();
    expect(
      matchCatchupMissedId(item, [catchupQueued({ estimatedFireAt: null })]),
    ).toBeNull();
    expect(
      matchCatchupMissedId(item, [catchupQueued({ pumpId: 'po4' })]),
    ).toBeNull();
  });

  it('attaches missedDoseId to resolved catch-up items', () => {
    const next = resolveNextDose(
      [],
      [queueItem({ id: 'c1', source: 'catchup' })],
      [catchupQueued()],
      NOW,
    );
    expect(next?.kind).toBe('queued');
    if (next?.kind !== 'queued') return;
    expect(next.missedDoseId).toBe('missed-1');
  });
});

describe('nextDoseActionPlan', () => {
  it('plans a skip for a scheduled dose', () => {
    const next = resolveNextDose([schedule()], [], [], NOW);
    if (next?.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(nextDoseActionPlan(next)).toEqual({ kind: 'skip' });
  });

  it('plans a manual cancel keyed by job id', () => {
    const next = resolveNextDose([], [queueItem({ id: 'm1' })], [], NOW);
    if (next?.kind !== 'queued') throw new Error('expected queued');
    expect(nextDoseActionPlan(next)).toEqual({
      kind: 'remove',
      cancel: 'manual',
      jobId: 'm1',
    });
  });

  it('plans a catch-up cancel keyed by missedDoseId', () => {
    const next = resolveNextDose(
      [],
      [queueItem({ id: 'c1', source: 'catchup' })],
      [catchupQueued()],
      NOW,
    );
    if (next?.kind !== 'queued') throw new Error('expected queued');
    expect(nextDoseActionPlan(next)).toEqual({
      kind: 'remove',
      cancel: 'catchup',
      missedDoseId: 'missed-1',
    });
  });

  it('plans remove-unavailable when the catch-up match is missing', () => {
    const next = resolveNextDose(
      [],
      [queueItem({ id: 'c1', source: 'catchup' })],
      [],
      NOW,
    );
    if (next?.kind !== 'queued') throw new Error('expected queued');
    expect(nextDoseActionPlan(next)).toEqual({ kind: 'remove-unavailable' });
  });
});
