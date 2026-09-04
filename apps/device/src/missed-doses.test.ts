// These fixtures use absolute UTC timestamps (e.g. setSystemTime with a "Z"
// string) and assert absolute UTC outcomes. Schedule times are interpreted as
// device-local wall clock, so pin the process TZ to UTC to keep local == UTC
// and the fixtures unambiguous on any machine.
process.env.TZ = 'UTC';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DoseEvent,
  DoseSchedule,
  MissedDose,
  MissedDoseStatus,
  PumpId,
} from '@reef/shared';
import {
  confirmMissedDose,
  confirmMissedDoses,
  detectMissedDoses,
  detectMissedDosesWithUntrustedClock,
  dismissMissedDose,
  expireStaleMissedDoses,
  fireScheduledConfirmations,
  snoozeMissedDoses,
  type MissedDosesEngine,
  type MissedDosesRepository,
} from '../src/missed-doses.js';

class FakeMissedDosesRepository
  implements MissedDosesRepository
{
  schedules: DoseSchedule[] = [];
  events: DoseEvent[] = [];
  missedDoses: MissedDose[] = [];
  systemVolumeLitres = 380;
  todayDoseMl = 0;

  getEnabledSchedules(): DoseSchedule[] {
    return this.schedules.filter((s) => s.enabled);
  }

  updateScheduleLastRunAt(id: string, lastRunAt: string): void {
    const schedule = this.schedules.find((s) => s.id === id);
    if (schedule) schedule.lastRunAt = lastRunAt;
  }

  getScheduleDoseEventsAfter(
    scheduleId: string,
    after: string,
  ): DoseEvent[] {
    return this.events.filter(
      (event) =>
        event.scheduleId === scheduleId && event.startedAt > after,
    );
  }

  getSystemVolumeLitres(): number {
    return this.systemVolumeLitres;
  }

  getTodayDoseMl(): number {
    return this.todayDoseMl;
  }

  createMissedDose(
    missed: Omit<MissedDose, 'id' | 'createdAt'>,
  ): MissedDose {
    const entry: MissedDose = {
      ...missed,
      id: `missed-${this.missedDoses.length + 1}`,
      createdAt: new Date().toISOString(),
    };
    this.missedDoses.push(entry);
    return entry;
  }

  getPendingMissedDoses(now: Date): MissedDose[] {
    return this.missedDoses.filter(
      (m) =>
        m.status === 'pending' &&
        (m.deferredUntil === null || m.deferredUntil <= now.toISOString()),
    );
  }

  getMissedDoseById(id: string): MissedDose | undefined {
    return this.missedDoses.find((m) => m.id === id);
  }

  updateMissedDoseStatus(id: string, status: MissedDoseStatus): void {
    const missed = this.missedDoses.find((m) => m.id === id);
    if (missed) missed.status = status;
  }

  snoozePendingMissedDoses(until: string): void {
    for (const missed of this.missedDoses) {
      if (missed.status === 'pending') missed.deferredUntil = until;
    }
  }

  setMissedDoseConfirmAfter(id: string, confirmAfter: string | null): void {
    const missed = this.missedDoses.find((m) => m.id === id);
    if (missed) missed.confirmAfter = confirmAfter;
  }

  getDueScheduledConfirmations(now: Date): MissedDose[] {
    const nowIso = now.toISOString();
    return this.missedDoses.filter(
      (m) =>
        m.status === 'confirmed' &&
        m.confirmAfter !== null &&
        m.confirmAfter <= nowIso,
    );
  }

  expireMissedDosesBefore(threshold: string): void {
    for (const missed of this.missedDoses) {
      if (missed.status === 'pending' && missed.createdAt < threshold) {
        missed.status = 'expired';
      }
    }
  }

  hasPendingMissedDoseForSlot(
    scheduleId: string,
    scheduledFor: string,
  ): boolean {
    // Dedupe spans ALL statuses: a dismissed/expired/confirmed slot must never
    // resurface as a fresh pending entry.
    return this.missedDoses.some(
      (m) => m.scheduleId === scheduleId && m.scheduledFor === scheduledFor,
    );
  }
}

function makeSchedule(
  overrides: Partial<DoseSchedule> & { pumpId: PumpId },
): DoseSchedule {
  return {
    id: 'sched-1',
    volumeMl: 1,
    timesPerDay: 1,
    startTime: '09:00',
    repeatEveryNDays: 1,
    enabled: true,
    lastRunAt: null,
    ...overrides,
  };
}

function createFakeEngine(
  onSubmit?: (pumpId: PumpId, amountMl: number, scheduleId: string) => void,
): MissedDosesEngine {
  return {
    submitDose: vi
      .fn()
      .mockImplementation(
        async (
          pumpId: PumpId,
          amountMl: number,
          _source: 'schedule',
          scheduleId: string,
        ) => {
          onSubmit?.(pumpId, amountMl, scheduleId);
          return 'job-id';
        },
      ),
  };
}

describe('detectMissedDoses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('creates a pending entry for a dose missed 30 minutes ago and does not fire it', () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-23T08:00:00.000Z',
      }),
    );

    detectMissedDoses(repo, now);

    expect(repo.missedDoses).toHaveLength(1);
    expect(repo.missedDoses[0]).toMatchObject({
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 1,
      status: 'pending',
    });
    // The scheduler must not auto-fire the missed slot; lastRunAt advances
    // to the missed due time, but no dose was submitted.
    expect(repo.events).toHaveLength(0);
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T09:00:00.000Z');
  });

  it('does not create an entry for a dose missed 2 days ago', () => {
    const now = new Date('2026-08-24T10:00:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        repeatEveryNDays: 2,
        lastRunAt: '2026-08-21T09:00:00.000Z',
      }),
    );

    detectMissedDoses(repo, now);

    // The only missed slot is 2026-08-23T09:00:00.000Z, which is older than
    // the 24-hour lookback window. It should be forgotten, not surfaced.
    expect(repo.missedDoses).toHaveLength(0);
  });

  it('untrusted-clock mode surfaces all intervening slots without a lookback cutoff', () => {
    const now = new Date('2026-08-29T10:00:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        repeatEveryNDays: 1,
        lastRunAt: '2026-08-28T09:00:00.000Z',
      }),
    );

    // Even though the 2026-08-29 09:00 slot is more than 24h after the
    // previous run, the untrusted-clock mode still surfaces it because we cannot
    // trust the wall clock to know whether it actually fired.
    detectMissedDosesWithUntrustedClock(repo, now);

    expect(repo.missedDoses).toHaveLength(1);
    expect(repo.missedDoses[0]).toMatchObject({
      scheduleId: 'sched-1',
      scheduledFor: '2026-08-29T09:00:00.000Z',
      status: 'pending',
    });
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-29T09:00:00.000Z');
  });

  it('does not duplicate a pending entry on restart', () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-23T08:00:00.000Z',
      }),
    );

    detectMissedDoses(repo, now);
    detectMissedDoses(repo, now);

    expect(repo.missedDoses).toHaveLength(1);
  });
});

describe('confirmMissedDose', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('fires the missed dose through the engine when confirmed', async () => {
    const repo = new FakeMissedDosesRepository();
    repo.schedules.push(
      makeSchedule({ id: 'sched-1', pumpId: 'alk', volumeMl: 2 }),
    );
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 2,
      status: 'pending',
      deferredUntil: null,
      confirmAfter: null,
      createdAt: new Date().toISOString(),
    });

    const engine = createFakeEngine();
    const jobId = await confirmMissedDose(repo, engine, 'missed-1');

    expect(jobId).toBe('job-id');
    expect(engine.submitDose).toHaveBeenCalledWith(
      'alk',
      2,
      'schedule',
      'sched-1',
    );
    expect(repo.missedDoses[0].status).toBe('confirmed');
  });

  it('rejects confirmation if it would exceed the single-dose limit', async () => {
    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 999,
      status: 'pending',
      deferredUntil: null,
      confirmAfter: null,
      createdAt: new Date().toISOString(),
    });

    const engine = createFakeEngine();
    await expect(
      confirmMissedDose(repo, engine, 'missed-1'),
    ).rejects.toThrow(/exceeds single-dose limit/i);

    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.missedDoses[0].status).toBe('pending');
  });

  it('rejects confirmation if it would exceed the daily total', async () => {
    const repo = new FakeMissedDosesRepository();
    repo.todayDoseMl = 24;
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 2,
      status: 'pending',
      deferredUntil: null,
      confirmAfter: null,
      createdAt: new Date().toISOString(),
    });

    const engine = createFakeEngine();
    await expect(
      confirmMissedDose(repo, engine, 'missed-1'),
    ).rejects.toThrow(/daily total/i);

    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.missedDoses[0].status).toBe('pending');
  });
});

describe('dismissMissedDose', () => {
  it('marks the missed dose dismissed and does not fire a dose', () => {
    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 1,
      status: 'pending',
      deferredUntil: null,
      confirmAfter: null,
      createdAt: new Date().toISOString(),
    });

    dismissMissedDose(repo, 'missed-1');

    expect(repo.missedDoses[0].status).toBe('dismissed');
  });
});

describe('expireStaleMissedDoses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('expires pending entries older than 24 hours with no dose fired', () => {
    const now = new Date('2026-08-24T10:00:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 1,
      status: 'pending',
      deferredUntil: null,
      confirmAfter: null,
      createdAt: '2026-08-23T09:30:00.000Z',
    });

    expireStaleMissedDoses(repo, now);

    expect(repo.missedDoses[0].status).toBe('expired');
  });

  it('leaves entries younger than 24 hours pending', () => {
    const now = new Date('2026-08-23T10:00:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      volumeMl: 1,
      status: 'pending',
      deferredUntil: null,
      confirmAfter: null,
      createdAt: '2026-08-23T09:30:00.000Z',
    });

    expireStaleMissedDoses(repo, now);

    expect(repo.missedDoses[0].status).toBe('pending');
  });
});

function makeMissedDose(
  overrides: Partial<MissedDose> & { id: string },
): MissedDose {
  return {
    scheduleId: 'sched-1',
    pumpId: 'alk',
    scheduledFor: '2026-08-23T09:00:00.000Z',
    volumeMl: 1,
    status: 'pending',
    deferredUntil: null,
    confirmAfter: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('dismiss permanence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('a dismissed entry never resurfaces on re-detection', () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-23T09:00:00.000Z',
      }),
    );
    repo.missedDoses.push(
      makeMissedDose({
        id: 'missed-1',
        scheduledFor: '2026-08-23T09:00:00.000Z',
        status: 'dismissed',
      }),
    );

    // Simulate the slot being re-scanned (e.g. lastRunAt lost and restored):
    // rewind lastRunAt to before the slot and run detection again.
    repo.updateScheduleLastRunAt('sched-1', '2026-08-23T08:00:00.000Z');
    detectMissedDoses(repo, now);

    expect(repo.missedDoses).toHaveLength(1);
    expect(repo.missedDoses[0].status).toBe('dismissed');
  });
});

describe('snoozeMissedDoses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('hides pending entries until the horizon, then re-includes them', () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push(makeMissedDose({ id: 'missed-1' }));

    const deferredUntil = snoozeMissedDoses(repo, now);

    expect(deferredUntil).toBe('2026-08-23T10:30:00.000Z');
    expect(repo.getPendingMissedDoses(now)).toHaveLength(0);

    // After the 60-minute snooze lapses the entry reappears (forced re-prompt).
    const later = new Date('2026-08-23T10:31:00Z');
    vi.setSystemTime(later);
    expect(repo.getPendingMissedDoses(later)).toHaveLength(1);
  });
});

describe('confirmMissedDoses (batch)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('fires only the selected entries; the rest stay pending', async () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
      makeMissedDose({ id: 'missed-2', scheduledFor: '2026-08-23T07:00:00.000Z' }),
    );

    const engine = createFakeEngine();
    const result = await confirmMissedDoses(repo, engine, ['missed-1'], now);

    expect(result.fired).toEqual(['missed-1']);
    expect(result.scheduled).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
    expect(engine.submitDose).toHaveBeenCalledWith('alk', 1, 'schedule', 'sched-1');
    expect(repo.missedDoses[0].status).toBe('confirmed');
    expect(repo.missedDoses[1].status).toBe('pending');
  });

  it('spaces same-pump catch-up doses: first fires now, second fires after the interval', async () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
      makeMissedDose({ id: 'missed-2', scheduledFor: '2026-08-23T07:00:00.000Z' }),
    );

    const engine = createFakeEngine();
    const result = await confirmMissedDoses(
      repo,
      engine,
      ['missed-1', 'missed-2'],
      now,
    );

    // First dose fires immediately; second is confirmed but delayed 30 min.
    expect(result.fired).toEqual(['missed-1']);
    expect(result.scheduled).toEqual(['missed-2']);
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
    expect(repo.missedDoses[1].status).toBe('confirmed');
    expect(repo.missedDoses[1].confirmAfter).toBe('2026-08-23T10:00:00.000Z');

    // Not due yet: the deferred dose must not fire early.
    const early = new Date('2026-08-23T09:59:00Z');
    vi.setSystemTime(early);
    await fireScheduledConfirmations(repo, engine, early);
    expect(engine.submitDose).toHaveBeenCalledTimes(1);

    // Once the spacing delay passes, the scheduler tick fires it.
    const due = new Date('2026-08-23T10:00:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    expect(engine.submitDose).toHaveBeenCalledTimes(2);
    expect(engine.submitDose).toHaveBeenLastCalledWith('alk', 1, 'schedule', 'sched-1');
    expect(repo.missedDoses[1].confirmAfter).toBeNull();
  });

  it('drops doses that would exceed the daily cap and reports them', async () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    // 380 L system -> maxDailyDoseMlPerPump = 24.7. With 23 mL already dosed
    // today, only one 1 mL catch-up fits; the second is dropped.
    const repo = new FakeMissedDosesRepository();
    repo.todayDoseMl = 23;
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
      makeMissedDose({ id: 'missed-2', scheduledFor: '2026-08-23T07:00:00.000Z' }),
    );

    const engine = createFakeEngine();
    const result = await confirmMissedDoses(
      repo,
      engine,
      ['missed-1', 'missed-2'],
      now,
    );

    expect(result.fired).toEqual(['missed-1']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].id).toBe('missed-2');
    expect(result.dropped[0].reason).toMatch(/today'?s limit|limit/i);
    // Dropped entries are dismissed permanently, never to re-nag.
    expect(repo.missedDoses[1].status).toBe('dismissed');
  });

  it('drops a deferred dose at fire time if the cap no longer fits', async () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push(
      makeMissedDose({
        id: 'missed-1',
        status: 'confirmed',
        confirmAfter: '2026-08-23T10:00:00.000Z',
      }),
    );

    // By fire time the daily budget is exhausted.
    repo.todayDoseMl = 24;
    const due = new Date('2026-08-23T10:00:00Z');
    vi.setSystemTime(due);

    const engine = createFakeEngine();
    await fireScheduledConfirmations(repo, engine, due);

    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.missedDoses[0].status).toBe('dismissed');
    expect(repo.missedDoses[0].confirmAfter).toBeNull();
  });
});
