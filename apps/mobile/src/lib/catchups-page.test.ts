import { describe, expect, it } from 'vitest';
import type { CatchupQueueItem, DoseEvent, MissedDose } from '@reef/shared';
import {
  buildCatchupsSummary,
  buildQueueSection,
  buildResolvedGroups,
  canCloseCatchups,
  dayLabelFor,
  groupMissedByPump,
  groupResolvedByDay,
  isBlockingMissedDose,
  RESOLVED_WINDOW_HOURS,
} from './catchups-page';

// Day grouping must be pinned to a non-UTC zone: an entry at 23:30 local and
// one at 00:30 local the next morning share a UTC date and would be silently
// merged by UTC date-slicing.
process.env.TZ = 'Pacific/Auckland';

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

function doseEvent(partial: Partial<DoseEvent> & { id: string }): DoseEvent {
  return {
    pumpId: 'alk',
    requestedMl: 1.5,
    actualMl: 1.5,
    status: 'completed',
    source: 'catchup',
    scheduleId: 's1',
    missedDoseId: `md-${partial.id}`,
    startedAt: '2026-08-24T06:48:00.000Z',
    finishedAt: '2026-08-24T06:49:00.000Z',
    error: null,
    missedDoseScheduledFor: '2026-08-23T06:00:00.000Z',
    ...partial,
  } as DoseEvent;
}

const PUMP_ORDER: Array<MissedDose['pumpId']> = ['alk', 'ca', 'no3', 'po4'];

describe('buildResolvedGroups', () => {
  it('renders both completed and dismissed rows (the dropped-rows bug)', () => {
    const fired = doseEvent({ id: 'ev-1', missedDoseId: 'md-alk' });
    const resolved = [
      missed({ id: 'md-alk', status: 'completed' }),
      missed({ id: 'md-po4', pumpId: 'po4', status: 'dismissed' }),
    ];
    const groups = buildResolvedGroups([fired], resolved, PUMP_ORDER);
    expect(groups).toHaveLength(4); // one top-level row per pump, always
    const alk = groups[0];
    expect(alk.pumpId).toBe('alk');
    expect(alk.deliveredCount).toBe(1);
    expect(alk.rows[0]).toMatchObject({
      outcome: 'delivered',
      missedSlotIso: '2026-08-23T06:00:00.000Z',
      ml: 1.5,
      deliveredKnown: true,
    });
    const po4 = groups[3];
    expect(po4.skippedCount).toBe(1);
    expect(po4.rows[0]).toMatchObject({ outcome: 'skipped', ml: 1.5 });
    expect(po4.deliveredCount).toBe(0);
    // Empty pumps still appear as zeroed groups.
    expect(groups[1].rows).toEqual([]);
    expect(groups[2].rows).toEqual([]);
  });

  it('always returns one group per pump in pump order', () => {
    const groups = buildResolvedGroups([], [], PUMP_ORDER);
    expect(groups.map((g) => g.pumpId)).toEqual(['alk', 'ca', 'no3', 'po4']);
    for (const g of groups) {
      expect(g.rows).toEqual([]);
      expect(g.deliveredCount).toBe(0);
      expect(g.skippedCount).toBe(0);
      expect(g.totalMl).toBe(0);
    }
  });

  it('computes summary counts and total mL per pump', () => {
    const resolved = [
      missed({ id: 'a1', status: 'completed', volumeMl: 1 }),
      missed({ id: 'a2', status: 'completed', volumeMl: 2 }),
      missed({ id: 'a3', status: 'dismissed' }),
      missed({ id: 'a4', status: 'dismissed' }),
      missed({ id: 'a5', status: 'expired' }),
    ];
    const fired = [
      doseEvent({ id: 'e1', missedDoseId: 'a1', actualMl: 1 }),
      doseEvent({ id: 'e2', missedDoseId: 'a2', actualMl: 2 }),
    ];
    const alk = buildResolvedGroups(fired, resolved, PUMP_ORDER)[0];
    expect(alk.deliveredCount).toBe(2);
    expect(alk.skippedCount).toBe(3); // 2 dismissed + 1 expired
    expect(alk.failedCount).toBe(0);
    expect(alk.totalMl).toBe(3);
  });

  it('orders rows chronologically within a pump', () => {
    const resolved = [
      missed({ id: 'late', status: 'dismissed', scheduledFor: '2026-08-24T04:00:00.000Z' }),
      missed({ id: 'early', status: 'dismissed', scheduledFor: '2026-08-24T01:00:00.000Z' }),
      missed({ id: 'mid', status: 'completed', scheduledFor: '2026-08-24T02:00:00.000Z' }),
    ];
    const alk = buildResolvedGroups([], resolved, PUMP_ORDER)[0];
    expect(alk.rows.map((r) => r.key)).toEqual([
      'resolved-early',
      'resolved-mid',
      'resolved-late',
    ]);
  });

  it('stays four groups with a 20-miss-per-pump outage', () => {
    const resolved: MissedDose[] = [];
    for (const pumpId of PUMP_ORDER) {
      for (let i = 0; i < 20; i++) {
        resolved.push(
          missed({
            id: `${pumpId}-${i}`,
            pumpId,
            status: i % 2 === 0 ? 'completed' : 'dismissed',
            scheduledFor: `2026-08-24T0${i % 6}:00:00.000Z`,
            volumeMl: 1,
          }),
        );
      }
    }
    const fired = resolved
      .filter((m) => m.status === 'completed')
      .map((m) =>
        doseEvent({
          id: `ev-${m.id}`,
          missedDoseId: m.id,
          pumpId: m.pumpId,
          actualMl: 1,
        }),
      );
    const groups = buildResolvedGroups(fired, resolved, PUMP_ORDER);
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(g.deliveredCount).toBe(10);
      expect(g.skippedCount).toBe(10);
      expect(g.rows).toHaveLength(20);
      expect(g.totalMl).toBe(10);
    }
  });

  it('a completed entry without a matched event renders as requested, not delivered', () => {
    // The dose event aged out of the 24h /api/history window: the entry must
    // still appear, labelled with the requested volume.
    const resolved = [missed({ id: 'md-alk', status: 'completed', volumeMl: 1.5 })];
    const alk = buildResolvedGroups([], resolved, PUMP_ORDER)[0];
    expect(alk.deliveredCount).toBe(1);
    expect(alk.rows[0]).toMatchObject({
      outcome: 'delivered',
      ml: 1.5,
      deliveredKnown: false,
    });
  });

  it('expired entries count as skipped and are labelled expired', () => {
    const resolved = [
      missed({ id: 'md-ca', pumpId: 'ca', status: 'expired' }),
    ];
    const ca = buildResolvedGroups([], resolved, PUMP_ORDER)[1];
    expect(ca.skippedCount).toBe(1);
    expect(ca.rows[0].outcome).toBe('expired');
  });

  it('failed entries are counted separately and carry the event error', () => {
    const fired = doseEvent({
      id: 'ev-f',
      missedDoseId: 'md-no3',
      pumpId: 'no3',
      status: 'failed',
      actualMl: 0,
      error: 'watchdog fired',
    });
    const resolved = [missed({ id: 'md-no3', pumpId: 'no3', status: 'failed' })];
    const no3 = buildResolvedGroups([fired], resolved, PUMP_ORDER)[2];
    expect(no3.failedCount).toBe(1);
    expect(no3.deliveredCount).toBe(0);
    expect(no3.rows[0]).toMatchObject({
      outcome: 'failed',
      error: 'watchdog fired',
      deliveredKnown: true,
      ml: 0,
    });
  });

  it('ignores non-terminal entries and non-catch-up events', () => {
    const resolved = [
      missed({ id: 'md-pending', status: 'pending' }),
      missed({ id: 'md-confirmed', status: 'confirmed' }),
      // Snoozed is still pending with a future deferredUntil — never renders.
      missed({
        id: 'md-snoozed',
        status: 'pending',
        deferredUntil: '2026-08-25T06:00:00.000Z',
      }),
      missed({ id: 'md-ok', status: 'dismissed' }),
    ];
    const scheduled = doseEvent({ id: 'ev-2', source: 'schedule' });
    const groups = buildResolvedGroups([scheduled], resolved, PUMP_ORDER);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].key).toBe('resolved-md-ok');
  });
});

describe('RESOLVED window + day grouping (7-day view)', () => {
  it('window constant is 168 hours', () => {
    expect(RESOLVED_WINDOW_HOURS).toBe(168);
  });

  // Local wall-clock construction: these instants are 23:30 and 00:30 on the
  // user's wall clock regardless of zone.
  const isoA = new Date(2026, 8, 11, 23, 30).toISOString(); // yesterday 23:30
  const isoB = new Date(2026, 8, 12, 0, 30).toISOString(); // today 00:30
  const isoC = new Date(2026, 8, 5, 9, 0).toISOString(); // Sat 5 Sep
  const now = new Date(2026, 8, 12, 10, 0).getTime();

  it('pin is active: the two boundary entries share a UTC date', () => {
    // Under the Auckland pin (+12) both are 2026-09-11 in UTC. If this
    // assertion fails the TZ pin didn't take and the grouping test below
    // would be vacuous.
    expect(isoA.slice(0, 10)).toBe('2026-09-11');
    expect(isoB.slice(0, 10)).toBe('2026-09-11');
  });

  it('splits same-UTC-day entries across local day boundaries', () => {
    const row = (id: string, missedSlotIso: string) => ({
      key: id,
      outcome: 'skipped' as const,
      missedSlotIso,
      ml: 1.5,
      deliveredKnown: false,
      error: null,
    });
    const groups = groupResolvedByDay([row('a', isoA), row('b', isoB)], now);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0].rows[0].key).toBe('b');
    expect(groups[1].rows[0].key).toBe('a');
  });

  it('labels Today / Yesterday / weekday dates on local boundaries', () => {
    expect(dayLabelFor(isoB, now)).toBe('Today');
    expect(dayLabelFor(isoA, now)).toBe('Yesterday');
    expect(dayLabelFor(isoC, now)).toBe(
      new Date(2026, 8, 5, 9, 0).toLocaleDateString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }),
    );
  });

  it('orders days newest-first and rows chronological within a day', () => {
    const row = (id: string, missedSlotIso: string) => ({
      key: id,
      outcome: 'skipped' as const,
      missedSlotIso,
      ml: 1,
      deliveredKnown: false,
      error: null,
    });
    const lateMorning = new Date(2026, 8, 12, 9, 0).toISOString();
    const earlyMorning = new Date(2026, 8, 12, 1, 0).toISOString();
    const groups = groupResolvedByDay(
      [row('late', lateMorning), row('old', isoC), row('early', earlyMorning)],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      new Date(2026, 8, 5, 9, 0).toLocaleDateString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }),
    ]);
    expect(groups[0].rows.map((r) => r.key)).toEqual(['early', 'late']);
    expect(groups[1].rows.map((r) => r.key)).toEqual(['old']);
  });

  it('collapsed pump summary aggregates counts and mL across the full window', () => {
    const resolved = [
      missed({ id: 'd1', status: 'completed', volumeMl: 1, scheduledFor: isoA }),
      missed({ id: 'd2', status: 'completed', volumeMl: 2, scheduledFor: isoC }),
      missed({ id: 'd3', status: 'dismissed', scheduledFor: isoB }),
    ];
    const fired = [
      doseEvent({ id: 'e1', missedDoseId: 'd1', actualMl: 1, missedDoseScheduledFor: isoA }),
      doseEvent({ id: 'e2', missedDoseId: 'd2', actualMl: 2, missedDoseScheduledFor: isoC }),
    ];
    const alk = buildResolvedGroups(fired, resolved, PUMP_ORDER)[0];
    expect(alk.deliveredCount).toBe(2);
    expect(alk.skippedCount).toBe(1);
    expect(alk.totalMl).toBe(3);
    expect(alk.rows).toHaveLength(3);
  });

  it('a 7-day-heavy fixture (30+ entries per pump) groups cleanly by day', () => {
    const resolved: MissedDose[] = [];
    for (const pumpId of PUMP_ORDER) {
      for (let i = 0; i < 32; i++) {
        const d = new Date(2026, 8, 6 + (i % 7), 6 + (i % 12), (i * 7) % 60);
        resolved.push(
          missed({
            id: `${pumpId}-${i}`,
            pumpId,
            status: i % 3 === 0 ? 'dismissed' : 'completed',
            scheduledFor: d.toISOString(),
            volumeMl: 1,
          }),
        );
      }
    }
    const fired = resolved
      .filter((m) => m.status === 'completed')
      .map((m) =>
        doseEvent({
          id: `ev-${m.id}`,
          missedDoseId: m.id,
          pumpId: m.pumpId,
          actualMl: 1,
          missedDoseScheduledFor: m.scheduledFor,
        }),
      );
    const groups = buildResolvedGroups(fired, resolved, PUMP_ORDER);
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(g.rows).toHaveLength(32);
      const dayGroups = groupResolvedByDay(g.rows, now);
      const rendered = dayGroups.reduce((n, d) => n + d.rows.length, 0);
      expect(rendered).toBe(32); // no row lost or duplicated in grouping
      // Day groups newest-first, non-empty.
      for (let i = 1; i < dayGroups.length; i++) {
        expect(dayGroups[i - 1].dayKey).toBeGreaterThan(dayGroups[i].dayKey);
      }
    }
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
