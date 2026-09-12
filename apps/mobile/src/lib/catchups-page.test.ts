import { describe, expect, it } from 'vitest';
import type { CatchupQueueItem, DoseEvent, MissedDose } from '@reef/shared';
import {
  buildCatchupsSummary,
  buildQueueSection,
  buildResolvedRows,
  canCloseCatchups,
  groupMissedByPump,
  isBlockingMissedDose,
} from './catchups-page';

function missed(partial: Partial<MissedDose> & { id: string }): MissedDose {
  return {
    scheduleId: 'sched-1',
    pumpId: 'alk',
    scheduledFor: '2026-08-23T06:00:00.000Z',
    volumeMl: 1.5,
    status: 'pending',
    createdAt: '2026-08-23T06:05:00.000Z',
    deferredUntil: null,
    confirmAfter: null,
    ...partial,
  };
}

function queueItem(partial: Partial<CatchupQueueItem> & { pumpId: CatchupQueueItem['pumpId'] }): CatchupQueueItem {
  return {
    missedDoseId: `md-${partial.pumpId}`,
    missedDoseScheduledFor: '2026-08-23T06:20:00.000Z',
    estimatedFireAt: '2026-08-24T06:48:00.000Z',
    ...partial,
  };
}

describe('isBlockingMissedDose', () => {
  const now = Date.parse('2026-08-24T10:00:00.000Z');

  it('blocks a pending entry with no snooze', () => {
    expect(isBlockingMissedDose(missed({ id: 'a' }), now)).toBe(true);
  });

  it('blocks when the snooze has lapsed', () => {
    expect(
      isBlockingMissedDose(
        missed({ id: 'a', deferredUntil: '2026-08-24T09:00:00.000Z' }),
        now,
      ),
    ).toBe(true);
  });

  it('does not block while snoozed or when terminal', () => {
    expect(
      isBlockingMissedDose(
        missed({ id: 'a', deferredUntil: '2026-08-24T11:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
    expect(
      isBlockingMissedDose(missed({ id: 'a', status: 'dismissed' }), now),
    ).toBe(false);
  });
});

describe('canCloseCatchups — forced-decision gating', () => {
  it('blocks dismissal in forced mode while any entry is pending', () => {
    expect(canCloseCatchups(true, 3)).toBe(false);
    expect(canCloseCatchups(true, 1)).toBe(false);
    expect(canCloseCatchups(true, 0)).toBe(true);
  });

  it('always allows leaving on voluntary visits', () => {
    expect(canCloseCatchups(false, 5)).toBe(true);
  });
});

describe('buildCatchupsSummary — Settings row states', () => {
  it('amber with pending count when decisions are needed', () => {
    const s = buildCatchupsSummary(3, null, 0);
    expect(s.tone).toBe('amber');
    expect(s.text).toBe('3 need your decision');
    expect(buildCatchupsSummary(1, null, 0).text).toBe('1 needs your decision');
  });

  it('aqua queue state wins over calm, pending wins over queue', () => {
    expect(buildCatchupsSummary(0, queueItem({ pumpId: 'alk' }), 4)).toEqual(
      expect.objectContaining({ tone: 'aqua', text: '1 firing, 4 queued' }),
    );
    expect(buildCatchupsSummary(0, null, 4).text).toBe('4 queued');
    expect(buildCatchupsSummary(0, queueItem({ pumpId: 'alk' }), 0).text).toBe(
      '1 firing',
    );
    // Pending outranks the queue.
    expect(buildCatchupsSummary(2, queueItem({ pumpId: 'alk' }), 4).tone).toBe(
      'amber',
    );
  });

  it('calm resting state otherwise', () => {
    expect(buildCatchupsSummary(0, null, 0)).toEqual(
      expect.objectContaining({ tone: 'calm', text: 'all caught up' }),
    );
  });
});

describe('buildQueueSection — refresh/remount derivation', () => {
  const statusPayload = {
    firing: queueItem({ pumpId: 'alk' }),
    queued: [
      queueItem({ pumpId: 'po4', estimatedFireAt: '2026-08-24T06:52:00.000Z' }),
      queueItem({ pumpId: 'ca', estimatedFireAt: '2026-08-24T06:53:00.000Z' }),
    ],
  };

  it('derives purely from the /api/status payload', () => {
    const section = buildQueueSection(
      statusPayload.firing,
      statusPayload.queued,
    );
    expect(section.firing?.pumpId).toBe('alk');
    expect(section.queued.map((q) => q.pumpId)).toEqual(['po4', 'ca']);
    expect(section.queued[0].estimatedFireAt).toBe('2026-08-24T06:52:00.000Z');
  });

  it('a remount with a fresh fetch of the same status renders identically', () => {
    // No local state exists between the two calls — the model is rebuilt
    // from the payload alone, which is what makes a full page refresh safe.
    const first = buildQueueSection(statusPayload.firing, statusPayload.queued);
    const remount = buildQueueSection(statusPayload.firing, statusPayload.queued);
    expect(remount).toEqual(first);
  });

  it('reflects a drained queue straight from the next status payload', () => {
    const drained = buildQueueSection(null, []);
    expect(drained.firing).toBeNull();
    expect(drained.queued).toEqual([]);
  });
});

describe('buildResolvedRows', () => {
  const fired: DoseEvent = {
    id: 'ev-1',
    pumpId: 'alk',
    requestedMl: 1.5,
    actualMl: 1.5,
    status: 'completed',
    source: 'catchup',
    scheduleId: 's1',
    missedDoseId: 'md-alk',
    startedAt: '2026-08-24T06:48:00.000Z',
    finishedAt: '2026-08-24T06:49:00.000Z',
    error: null,
    missedDoseScheduledFor: '2026-08-23T06:00:00.000Z',
  } as DoseEvent;

  it('lists fired catch-ups with delivered mL and the missed slot', () => {
    const rows = buildResolvedRows([fired], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'fired',
      pumpId: 'alk',
      missedSlotIso: '2026-08-23T06:00:00.000Z',
      actualMl: 1.5,
      status: 'completed',
    });
  });

  it('lists skipped entries and never shows an entry twice', () => {
    const resolved = [
      missed({ id: 'md-alk', status: 'completed' }), // backed by the fired event
      missed({ id: 'md-po4', pumpId: 'po4', status: 'dismissed' }),
      missed({ id: 'md-ca', pumpId: 'ca', status: 'expired' }),
    ];
    const rows = buildResolvedRows([fired], resolved);
    expect(rows).toHaveLength(3);
    const kinds = rows.map((r) => `${r.kind}:${r.pumpId}`);
    expect(kinds).toContain('fired:alk');
    expect(kinds).toContain('skipped:po4');
    expect(kinds).toContain('skipped:ca');
    // The completed missed row was folded into the fired row — no duplicate.
    expect(rows.filter((r) => r.pumpId === 'alk')).toHaveLength(1);
    const skipped = rows.find((r) => r.pumpId === 'po4');
    expect(skipped).toMatchObject({ reason: 'skipped', volumeMl: 1.5 });
    expect(rows.find((r) => r.pumpId === 'ca')).toMatchObject({
      reason: 'expired',
    });
  });

  it('ignores non-catch-up history events', () => {
    const scheduled = { ...fired, id: 'ev-2', source: 'schedule' as const };
    expect(buildResolvedRows([scheduled], [])).toHaveLength(0);
  });
});

describe('groupMissedByPump', () => {
  it('groups in pump order and skips empty pumps', () => {
    const groups = groupMissedByPump(
      [
        missed({ id: '1', pumpId: 'po4' }),
        missed({ id: '2', pumpId: 'alk' }),
        missed({ id: '3', pumpId: 'alk' }),
      ],
      ['alk', 'ca', 'no3', 'po4'],
    );
    expect(groups.map((g) => g.pumpId)).toEqual(['alk', 'po4']);
    expect(groups[0].entries.map((e) => e.id)).toEqual(['2', '3']);
  });
});
