import { describe, expect, it } from 'vitest';
import type { DoseEvent, DoseQueueItem } from '@reef/shared';
import { buildQueuePanel, sourceLabel } from './dose-queue';

function event(partial: Partial<DoseEvent> & { id: string }): DoseEvent {
  return {
    pumpId: 'ca',
    requestedMl: 2,
    actualMl: null,
    status: 'running',
    source: 'manual',
    scheduleId: null,
    missedDoseId: null,
    startedAt: '2026-09-14T09:00:00.000Z',
    finishedAt: null,
    error: null,
    ...partial,
  };
}

function queueItem(
  partial: Partial<DoseQueueItem> & { id: string },
): DoseQueueItem {
  return {
    pumpId: 'alk',
    amountMl: 1.5,
    source: 'manual',
    estimatedFireAt: '2026-09-14T09:05:00.000Z',
    ...partial,
  };
}

describe('buildQueuePanel', () => {
  it('lays out a firing dose at position 0 followed by queued items at 1..n', () => {
    const rows = buildQueuePanel(event({ id: 'job-now' }), [
      queueItem({ id: 'job-1', pumpId: 'alk' }),
      queueItem({
        id: 'job-2',
        pumpId: 'po4',
        amountMl: 0.75,
        estimatedFireAt: '2026-09-14T09:10:00.000Z',
      }),
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({
      position: 0,
      isCurrent: true,
      canCancel: false,
      pumpId: 'ca',
      amountMl: 2,
      jobId: 'job-now',
    });
    expect(rows[1]).toMatchObject({
      position: 1,
      isCurrent: false,
      pumpId: 'alk',
      amountMl: 1.5,
      jobId: 'job-1',
    });
    expect(rows[2]).toMatchObject({ position: 2, pumpId: 'po4', amountMl: 0.75 });
  });

  it('cancels only manual rows — catch-up and schedule rows are display-only', () => {
    const rows = buildQueuePanel(null, [
      queueItem({ id: 'm1', source: 'manual' }),
      queueItem({ id: 'c1', source: 'catchup' }),
      queueItem({ id: 's1', source: 'schedule' }),
    ]);

    expect(rows.map((r) => [r.jobId, r.canCancel])).toEqual([
      ['m1', true],
      ['c1', false],
      ['s1', false],
    ]);
  });

  it('empty queue with nothing firing renders an empty panel', () => {
    expect(buildQueuePanel(null, [])).toEqual([]);
  });
});

describe('sourceLabel', () => {
  it("maps 'catchup' to 'catch-up', passes other sources through", () => {
    expect(sourceLabel('catchup')).toBe('catch-up');
    expect(sourceLabel('manual')).toBe('manual');
    expect(sourceLabel('schedule')).toBe('schedule');
  });
});
