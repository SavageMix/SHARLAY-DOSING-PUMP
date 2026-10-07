import { describe, expect, it } from 'vitest';
import type { DoseEvent, DoseQueueItem } from '@reef/shared';
import {
  reconcileDoseStates,
  type DoseStates,
  type DoseTrackingState,
} from './dose-states';

function event(partial: Partial<DoseEvent> & { id: string }): DoseEvent {
  return {
    pumpId: 'ca',
    requestedMl: 2,
    actualMl: 2,
    status: 'completed',
    source: 'manual',
    scheduleId: null,
    missedDoseId: null,
    startedAt: '2026-09-14T09:00:00.000Z',
    finishedAt: '2026-09-14T09:01:00.000Z',
    error: null,
    ...partial,
  };
}

function tracking(
  partial: Partial<DoseTrackingState> & { eventId?: string },
): DoseTrackingState {
  return { status: 'queued', message: 'Queued', ...partial };
}

const NO_LIVE = { currentDose: null, queue: [] as DoseEvent[] };

function queueItem(
  partial: Partial<DoseQueueItem> & { id: string },
): DoseQueueItem {
  return {
    pumpId: 'ca',
    amountMl: 2,
    source: 'manual',
    estimatedFireAt: '2026-09-14T09:05:00.000Z',
    ...partial,
  };
}

describe('reconcileDoseStates', () => {
  it('cap-rejected dose (failed in history) shows the server reason, never done', () => {
    const prev: DoseStates = {
      ca: tracking({ status: 'running', message: 'Dosing…', eventId: 'job-1' }),
    };
    const next = reconcileDoseStates(prev, {
      ...NO_LIVE,
      history: [
        event({
          id: 'job-1',
          status: 'failed',
          error: 'Daily total for ca would exceed 24.70mL',
        }),
      ],
    });

    expect(next.ca.status).toBe('error');
    expect(next.ca.message).toBe(
      'Daily total for ca would exceed 24.70mL',
    );
    expect(next.ca.status).not.toBe('done');
    // The rejection must not flash 'completed' at any point, and the entry
    // must not linger as in-progress.
    expect(next.ca.status).not.toBe('running');
  });

  it('completed dose in history resolves to done', () => {
    const prev: DoseStates = {
      ca: tracking({ status: 'running', message: 'Dosing…', eventId: 'job-2' }),
    };
    const next = reconcileDoseStates(prev, {
      ...NO_LIVE,
      history: [event({ id: 'job-2' })],
    });

    expect(next.ca).toEqual({
      status: 'done',
      message: 'Dose finished',
      eventId: 'job-2',
    });
  });

  it('no verdict available yet: keeps the current state instead of guessing', () => {
    // The event left the live queue but history has not caught up (fetch in
    // flight). The old code promoted this straight to 'done' — the completed
    // flash. Now it must hold until the verdict arrives.
    const prev: DoseStates = {
      ca: tracking({ eventId: 'job-3' }),
    };
    const next = reconcileDoseStates(prev, { ...NO_LIVE, history: [] });

    expect(next.ca).toEqual(prev.ca);

    // Next poll brings the failed verdict.
    const resolved = reconcileDoseStates(next, {
      ...NO_LIVE,
      history: [
        event({ id: 'job-3', status: 'failed', error: 'Pump ca is not calibrated' }),
      ],
    });
    expect(resolved.ca.status).toBe('error');
    expect(resolved.ca.message).toBe('Pump ca is not calibrated');
  });

  it('interrupted dose reports an error even without a server message', () => {
    const prev: DoseStates = {
      alk: tracking({ eventId: 'job-4' }),
    };
    const next = reconcileDoseStates(prev, {
      ...NO_LIVE,
      history: [event({ id: 'job-4', pumpId: 'alk', status: 'interrupted' })],
    });

    expect(next.alk.status).toBe('error');
    expect(next.alk.message).toBe('Dose interrupted');
  });

  it('live queue drives running and queued-position states', () => {
    const prev: DoseStates = {
      ca: tracking({ eventId: 'job-5' }),
      alk: tracking({ eventId: 'job-6' }),
    };
    const next = reconcileDoseStates(prev, {
      currentDose: event({ id: 'job-5', status: 'running', actualMl: null }),
      queue: [
        event({ id: 'job-6', pumpId: 'alk', status: 'queued', actualMl: null }),
      ],
      history: [],
    });

    expect(next.ca).toEqual({
      status: 'running',
      message: 'Dosing…',
      eventId: 'job-5',
    });
    expect(next.alk).toEqual({
      status: 'queued',
      message: 'Queued #1',
      eventId: 'job-6',
    });
  });

  it('terminal status straight from the live queue resolves immediately', () => {
    const prev: DoseStates = {
      ca: tracking({ status: 'running', message: 'Dosing…', eventId: 'job-7' }),
    };
    const next = reconcileDoseStates(prev, {
      currentDose: null,
      queue: [
        event({
          id: 'job-7',
          status: 'failed',
          error: 'Single dose 10mL exceeds limit 4.94mL',
          actualMl: null,
          finishedAt: null,
        }),
      ],
      history: [],
    });

    expect(next.ca.status).toBe('error');
    expect(next.ca.message).toBe('Single dose 10mL exceeds limit 4.94mL');
  });

  it('does not touch done/error/idle entries or untracked pumps', () => {
    const prev: DoseStates = {
      ca: { status: 'done', message: 'Dose finished', eventId: 'job-8' },
      alk: { status: 'error', message: 'Earlier failure', eventId: 'job-9' },
      no3: { status: 'idle', message: '' },
    };
    const next = reconcileDoseStates(prev, {
      ...NO_LIVE,
      history: [
        event({ id: 'job-8', status: 'failed', error: 'late failure report' }),
      ],
    });

    expect(next).toEqual(prev);
  });

  it('queueItems membership drives the queued state and 1-based position', () => {
    const prev: DoseStates = {
      alk: tracking({ eventId: 'job-10' }),
    };
    const next = reconcileDoseStates(prev, {
      ...NO_LIVE,
      queueItems: [
        queueItem({ id: 'job-11', pumpId: 'ca' }),
        queueItem({ id: 'job-10', pumpId: 'alk' }),
      ],
      history: [],
    });

    expect(next.alk).toEqual({
      status: 'queued',
      message: 'Queued #2',
      eventId: 'job-10',
    });
  });

  it("a 'cancelled' history event resolves to idle — no banner, not an error", () => {
    const prev: DoseStates = {
      ca: tracking({ eventId: 'job-12' }),
    };
    const next = reconcileDoseStates(prev, {
      ...NO_LIVE,
      history: [
        event({
          id: 'job-12',
          status: 'cancelled',
          actualMl: null,
          finishedAt: null,
          error: 'Cancelled by user before it fired',
        }),
      ],
    });

    expect(next.ca).toEqual({ status: 'idle', message: '' });
  });

  it('reconciling the same status twice is idempotent', () => {
    const prev: DoseStates = {
      ca: tracking({ eventId: 'job-13' }),
    };
    const input = {
      ...NO_LIVE,
      queueItems: [queueItem({ id: 'job-13' })],
      history: [],
    };
    const once = reconcileDoseStates(prev, input);
    const twice = reconcileDoseStates(once, input);

    expect(twice).toEqual(once);
    expect(twice.ca).toEqual({
      status: 'queued',
      message: 'Queued #1',
      eventId: 'job-13',
    });
  });
});
