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
import { ReefDatabase } from '../src/db.js';

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

  getLastCompletedDoseAt(pumpId: PumpId): string | null {
    const completed = this.events.filter(
      (e) => e.pumpId === pumpId && e.status === 'completed',
    );
    if (completed.length === 0) return null;
    return completed.reduce((max, e) => (e.startedAt > max ? e.startedAt : max), '');
  }

  getLastDoseStartedAt(pumpId: PumpId): string | null {
    const started = this.events.filter(
      (e) =>
        e.pumpId === pumpId &&
        e.startedAt !== '' &&
        ['running', 'completed', 'failed', 'interrupted'].includes(e.status),
    );
    if (started.length === 0) return null;
    return started.reduce((max, e) => (e.startedAt > max ? e.startedAt : max), '');
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

  expireMissedDosesBefore(threshold: string): number {
    let expired = 0;
    for (const missed of this.missedDoses) {
      if (missed.status === 'pending' && missed.createdAt < threshold) {
        missed.status = 'expired';
        expired += 1;
      }
    }
    return expired;
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
          _source: 'schedule' | 'catchup',
          scheduleId: string,
          _missedDoseId?: string | null,
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

  it('treats a slot whose dose was interrupted mid-run as missed (conservative)', () => {
    // The process died mid-dose: the event is left 'running'/'interrupted' by
    // boot reconciliation, but the tank never received the full volume. The
    // slot must surface as a pending missed dose, not count as delivered.
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
    repo.events.push({
      id: 'event-1',
      pumpId: 'alk',
      requestedMl: 1,
      actualMl: 0.2,
      status: 'interrupted',
      source: 'schedule',
      scheduleId: 'sched-1',
      missedDoseId: null,
      startedAt: '2026-08-23T09:00:05.000Z',
      finishedAt: null,
      error: null,
    });

    detectMissedDoses(repo, now);

    expect(repo.missedDoses).toHaveLength(1);
    expect(repo.missedDoses[0]).toMatchObject({
      scheduleId: 'sched-1',
      scheduledFor: '2026-08-23T09:00:00.000Z',
      status: 'pending',
    });
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
      'catchup',
      'sched-1',
      'missed-1',
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

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expireStaleMissedDoses(repo, now);
    } finally {
      logSpy.mockRestore();
    }

    expect(repo.missedDoses[0].status).toBe('pending');
    // Nothing expired — the sweep must stay silent.
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('expired undelivered'),
    );
  });

  it('writes a journal line per expired batch, visible in journalctl', () => {
    const now = new Date('2026-08-24T10:00:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    for (const id of ['missed-1', 'missed-2']) {
      repo.missedDoses.push({
        id,
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-08-23T09:00:00.000Z',
        volumeMl: 1,
        status: 'pending',
        deferredUntil: null,
        confirmAfter: null,
        createdAt: '2026-08-23T09:30:00.000Z',
      });
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expireStaleMissedDoses(repo, now);
      expect(logSpy).toHaveBeenCalledWith(
        '[missed] 2 entries expired undelivered — owner never decided',
      );

      // A second pass expires nothing — no repeated line.
      logSpy.mockClear();
      expireStaleMissedDoses(repo, now);
      expect(
        logSpy.mock.calls.filter((args) =>
          String(args[0]).includes('expired undelivered'),
        ),
      ).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('expired entries leave the pending list, never inflate pending counts, and show in the resolved query', () => {
    // End-to-end against the real database layer: the TTL sweep must not
    // make entries vanish — they stay queryable as 'expired' for RESOLVED.
    const db = new ReefDatabase(':memory:');
    try {
      // created_at is stamped from the system clock, so wind the fake clock
      // back to plant an entry old enough to expire.
      vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));
      db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'po4',
        scheduledFor: '2026-08-23T09:00:00.000Z',
        volumeMl: 2,
        status: 'pending',
        deferredUntil: null,
        confirmAfter: null,
      });
      vi.setSystemTime(new Date('2026-08-24T09:30:00Z'));
      db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-08-24T09:00:00.000Z',
        volumeMl: 1,
        status: 'pending',
        deferredUntil: null,
        confirmAfter: null,
      });

      const now = new Date('2026-08-24T10:00:00Z');
      vi.setSystemTime(now);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expireStaleMissedDoses(db, now);
      } finally {
        logSpy.mockRestore();
      }

      // Pending counts cover only the fresh entry…
      expect(db.getPendingMissedDoses(now, true)).toHaveLength(1);
      expect(db.getPendingMissedDoses(now, true)[0].pumpId).toBe('alk');
      // …the expired one is terminal but still reported via the resolved
      // endpoint payload (status 'expired', volume intact).
      const resolved = db.getResolvedMissedDoses(now, 168);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].status).toBe('expired');
      expect(resolved[0].pumpId).toBe('po4');
      expect(resolved[0].volumeMl).toBe(2);
      expect(resolved[0].scheduledFor).toBe('2026-08-23T09:00:00.000Z');
    } finally {
      db.close();
    }
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
    expect(engine.submitDose).toHaveBeenCalledWith(
      'alk',
      1,
      'catchup',
      'sched-1',
      'missed-1',
    );
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
    expect(engine.submitDose).toHaveBeenLastCalledWith(
      'alk',
      1,
      'catchup',
      'sched-1',
      'missed-2',
    );
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


describe('catch-up eligibility gate (stagger from the pump actual last dose)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** Completed schedule dose for a pump at an absolute instant. */
  function completedDose(pumpId: PumpId, startedAt: string): DoseEvent {
    return {
      id: `ev-${pumpId}-${startedAt}`,
      pumpId,
      requestedMl: 1,
      actualMl: 1,
      status: 'completed',
      source: 'schedule',
      scheduleId: 'sched-1',
      missedDoseId: null,
      startedAt,
      finishedAt: startedAt,
      error: null,
    };
  }

  /**
   * An engine fake that records each fire instant AND appends a completed
   * dose event at that instant — so later eligibility checks see the dose
   * the way production does (instant completion: cadence stays exact).
   */
  function recordingEngine(repo: FakeMissedDosesRepository): {
    engine: MissedDosesEngine;
    fires: string[];
  } {
    const fires: string[] = [];
    const engine = createFakeEngine((pumpId, _amountMl, _scheduleId) => {
      const startedAt = new Date().toISOString();
      fires.push(startedAt);
      repo.events.push({
        ...completedDose(pumpId, startedAt),
        source: 'catchup',
      });
    });
    return { engine, fires };
  }

  /**
   * Serial engine fake mirroring production timing: only ONE dose runs at a
   * time, queued submits produce no dose_events row until the dose actually
   * STARTS (so the eligibility gate cannot see them), and a dose takes a
   * fixed wall-clock duration. Completing a dose atomically closes its
   * missed_doses entry — exactly the contract the real engine honours.
   */
  class SerialCatchupEngine implements MissedDosesEngine {
    private queue: Array<{
      eventId: string;
      pumpId: PumpId;
      amountMl: number;
      missedDoseId: string | null;
    }> = [];
    private current: {
      eventId: string;
      missedDoseId: string | null;
      startedAtMs: number;
      durationMs: number;
    } | null = null;
    private counter = 0;

    constructor(
      private readonly repo: FakeMissedDosesRepository,
      private readonly catchupDurationMs: number,
    ) {}

    /** Seed an in-flight dose for a pump (e.g. a manual dose still running). */
    preloadRunning(
      pumpId: PumpId,
      startedAt: Date,
      durationMs: number,
      source: 'manual' | 'schedule' = 'manual',
    ): void {
      const eventId = `ev-preload-${pumpId}`;
      this.repo.events.push({
        id: eventId,
        pumpId,
        requestedMl: 0,
        actualMl: null,
        status: 'running',
        source,
        scheduleId: null,
        missedDoseId: null,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        error: null,
      });
      this.current = {
        eventId,
        missedDoseId: null,
        startedAtMs: startedAt.getTime(),
        durationMs,
      };
    }

    hasPendingWork(): boolean {
      return this.current !== null || this.queue.length > 0;
    }

    async submitDose(
      pumpId: PumpId,
      amountMl: number,
      _source: 'schedule' | 'catchup',
      _scheduleId: string,
      missedDoseId?: string | null,
    ): Promise<string> {
      const eventId = `ev-${++this.counter}`;
      this.queue.push({
        eventId,
        pumpId,
        amountMl,
        missedDoseId: missedDoseId ?? null,
      });
      return eventId;
    }

    step(now: Date): void {
      if (
        this.current &&
        now.getTime() - this.current.startedAtMs >= this.current.durationMs
      ) {
        const event = this.repo.events.find(
          (e) => e.id === this.current!.eventId,
        );
        if (event) {
          event.status = 'completed';
          event.finishedAt = now.toISOString();
        }
        if (this.current.missedDoseId) {
          this.repo.updateMissedDoseStatus(
            this.current.missedDoseId,
            'completed',
          );
        }
        this.current = null;
      }
      if (this.current === null && this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.repo.events.push({
          id: next.eventId,
          pumpId: next.pumpId,
          requestedMl: next.amountMl,
          actualMl: null,
          status: 'running',
          source: 'catchup',
          scheduleId: null,
          missedDoseId: next.missedDoseId,
          startedAt: now.toISOString(),
          finishedAt: null,
          error: null,
        });
        this.current = {
          eventId: next.eventId,
          missedDoseId: next.missedDoseId,
          startedAtMs: now.getTime(),
          durationMs: this.catchupDurationMs,
        };
      }
    }
  }

  it('two confirmations 10 minutes apart on one pump fire 30 minutes apart', async () => {
    const t0 = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(t0);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
      makeMissedDose({ id: 'missed-2', scheduledFor: '2026-08-23T07:00:00.000Z' }),
    );
    const { engine, fires } = recordingEngine(repo);

    // First batch: fires immediately (pump never dosed), second entry held.
    await confirmMissedDoses(repo, engine, ['missed-1', 'missed-2'], t0);
    expect(fires).toEqual(['2026-08-23T09:30:00.000Z']);

    // Ten minutes later the user confirms a third entry. The anchor is the
    // 09:30 dose that actually fired — NOT the 10:00 confirmAfter of the
    // queued entry — so this one waits until 10:00.
    const t1 = new Date('2026-08-23T09:40:00Z');
    vi.setSystemTime(t1);
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-3', scheduledFor: '2026-08-23T08:00:00.000Z' }),
    );
    const result = await confirmMissedDoses(repo, engine, ['missed-3'], t1);
    expect(result.fired).toEqual([]);
    expect(result.scheduled).toEqual(['missed-3']);
    expect(repo.missedDoses[2].confirmAfter).toBe('2026-08-23T10:00:00.000Z');

    const due = new Date('2026-08-23T10:00:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    // At 10:00 BOTH missed-2 (held since the first batch) and missed-3 are
    // due. The first fires; the second sees the just-fired 10:00 dose as the
    // pump's last dose and waits its own 30 minutes — two same-pump doses
    // never land in the same instant.
    expect(fires).toEqual([
      '2026-08-23T09:30:00.000Z',
      '2026-08-23T10:00:00.000Z',
    ]);
    expect(repo.missedDoses[2].status).toBe('confirmed');
    expect(repo.missedDoses[2].confirmAfter).toBe('2026-08-23T10:00:00.000Z');

    const later = new Date('2026-08-23T10:30:00Z');
    vi.setSystemTime(later);
    await fireScheduledConfirmations(repo, engine, later);
    expect(fires).toHaveLength(3);
    expect(repo.missedDoses[2].confirmAfter).toBeNull();
  });

  it('a catch-up waits the full 30 minutes from a scheduled dose 5 minutes ago', async () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.events.push(completedDose('alk', '2026-08-23T09:25:00Z'));
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
    );
    const { engine, fires } = recordingEngine(repo);

    const result = await confirmMissedDoses(repo, engine, ['missed-1'], now);
    expect(result.fired).toEqual([]);
    expect(result.scheduled).toEqual(['missed-1']);
    expect(repo.missedDoses[0].confirmAfter).toBe('2026-08-23T09:55:00.000Z');

    const early = new Date('2026-08-23T09:54:59Z');
    vi.setSystemTime(early);
    await fireScheduledConfirmations(repo, engine, early);
    expect(fires).toEqual([]);

    const due = new Date('2026-08-23T09:55:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    expect(fires).toEqual(['2026-08-23T09:55:00.000Z']);
  });

  it('boot with a confirmed entry due right after a dose: the catch-up waits', async () => {
    const boot = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(boot);

    const repo = new FakeMissedDosesRepository();
    repo.events.push(completedDose('alk', '2026-08-23T09:20:00Z'));
    repo.missedDoses.push(
      makeMissedDose({
        id: 'missed-1',
        scheduledFor: '2026-08-23T06:00:00.000Z',
        status: 'confirmed',
        confirmAfter: '2026-08-23T08:00:00.000Z', // due long ago
      }),
    );
    const { engine, fires } = recordingEngine(repo);

    // First tick after boot: confirmAfter has passed, but the pump dosed 10
    // minutes ago — the entry stays queued.
    await fireScheduledConfirmations(repo, engine, boot);
    expect(fires).toEqual([]);
    expect(repo.missedDoses[0].status).toBe('confirmed');
    expect(repo.missedDoses[0].confirmAfter).toBe('2026-08-23T08:00:00.000Z');

    const due = new Date('2026-08-23T09:50:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    expect(fires).toEqual(['2026-08-23T09:50:00.000Z']);
  });

  it('steady-state cadence is unchanged: exact 30-minute spacing', async () => {
    const t0 = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(t0);

    const repo = new FakeMissedDosesRepository();
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
      makeMissedDose({ id: 'missed-2', scheduledFor: '2026-08-23T07:00:00.000Z' }),
      makeMissedDose({ id: 'missed-3', scheduledFor: '2026-08-23T08:00:00.000Z' }),
    );
    const { engine, fires } = recordingEngine(repo);

    await confirmMissedDoses(
      repo,
      engine,
      ['missed-1', 'missed-2', 'missed-3'],
      t0,
    );
    expect(fires).toEqual(['2026-08-23T09:30:00.000Z']);

    for (const instant of ['2026-08-23T10:00:00Z', '2026-08-23T10:30:00Z']) {
      vi.setSystemTime(new Date(instant));
      await fireScheduledConfirmations(repo, engine, new Date(instant));
    }

    expect(fires).toEqual([
      '2026-08-23T09:30:00.000Z',
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:30:00.000Z',
    ]);
    expect(engine.submitDose).toHaveBeenCalledTimes(3);
    for (const m of repo.missedDoses) expect(m.confirmAfter).toBeNull();
  });

  it('a waiting entry is never lost: queued across ticks, fired exactly once', async () => {
    const repo = new FakeMissedDosesRepository();
    repo.events.push(completedDose('alk', '2026-08-23T09:20:00Z'));
    repo.missedDoses.push(
      makeMissedDose({
        id: 'missed-1',
        scheduledFor: '2026-08-23T06:00:00.000Z',
        status: 'confirmed',
        confirmAfter: '2026-08-23T09:00:00.000Z',
      }),
    );
    const { engine, fires } = recordingEngine(repo);

    // Four ticks across the wait — none may drop, fire, or corrupt it.
    for (const instant of [
      '2026-08-23T09:30:00Z',
      '2026-08-23T09:35:00Z',
      '2026-08-23T09:40:00Z',
      '2026-08-23T09:45:00Z',
    ]) {
      vi.setSystemTime(new Date(instant));
      await fireScheduledConfirmations(repo, engine, new Date(instant));
      expect(fires).toEqual([]);
      expect(repo.missedDoses[0].status).toBe('confirmed');
      expect(repo.missedDoses[0].confirmAfter).toBe('2026-08-23T09:00:00.000Z');
    }

    const due = new Date('2026-08-23T09:50:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    expect(fires).toEqual(['2026-08-23T09:50:00.000Z']);
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
  });

  it('single confirm defers (jobId null) instead of firing early', async () => {
    const now = new Date('2026-08-23T09:30:00Z');
    vi.setSystemTime(now);

    const repo = new FakeMissedDosesRepository();
    repo.events.push(completedDose('alk', '2026-08-23T09:25:00Z'));
    repo.missedDoses.push(
      makeMissedDose({ id: 'missed-1', scheduledFor: '2026-08-23T06:00:00.000Z' }),
    );
    const { engine } = recordingEngine(repo);

    const jobId = await confirmMissedDose(repo, engine, 'missed-1');
    expect(jobId).toBeNull();
    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.missedDoses[0].status).toBe('confirmed');
    expect(repo.missedDoses[0].confirmAfter).toBe('2026-08-23T09:55:00.000Z');

    const due = new Date('2026-08-23T09:55:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
  });

  it('an in-flight dose blocks the next catch-up for the full interval measured from its start', async () => {
    // The production incident (Oct 2): po4 catch-ups fired 1m47s apart —
    // exactly one dose duration. The gate saw only COMPLETED doses, so while
    // dose A was running, entry B passed eligibility and fired the instant A
    // completed. The gate must anchor on dose STARTS, running ones included.
    const t0 = new Date('2026-10-02T09:00:00Z');
    vi.setSystemTime(t0);

    const repo = new FakeMissedDosesRepository();
    // ca: an ancient completed dose AND a dose IN FLIGHT since 09:00.
    repo.events.push(
      completedDose('ca', '2026-10-02T08:00:00Z'),
      {
        ...completedDose('ca', '2026-10-02T09:00:00Z'),
        id: 'ev-ca-running',
        status: 'running',
        finishedAt: null,
      },
    );
    repo.missedDoses.push(
      makeMissedDose({
        id: 'missed-1',
        pumpId: 'ca',
        scheduledFor: '2026-10-02T06:00:00.000Z',
      }),
    );
    const { engine, fires } = recordingEngine(repo);

    // In flight since 09:00 → not eligible at confirm time; held to 09:30
    // measured from the START, not from whenever the dose completes.
    await confirmMissedDoses(repo, engine, ['missed-1'], t0);
    expect(fires).toEqual([]);
    expect(repo.missedDoses[0].confirmAfter).toBe('2026-10-02T09:30:00.000Z');

    // 09:29:59 — the completed-only gate would fire this (last completed
    // 08:00, well over 30 min ago). Start-anchored gating holds it.
    const early = new Date('2026-10-02T09:29:59Z');
    vi.setSystemTime(early);
    await fireScheduledConfirmations(repo, engine, early);
    expect(fires).toEqual([]);

    const due = new Date('2026-10-02T09:30:00Z');
    vi.setSystemTime(due);
    await fireScheduledConfirmations(repo, engine, due);
    expect(fires).toEqual(['2026-10-02T09:30:00.000Z']);
  });

  it('9 confirmed catch-ups per pump never start less than 30 minutes apart, even with a busy engine completing doses late', async () => {
    // Full-drain simulation with a serial engine: doses run ONE AT A TIME
    // for 2 minutes each, and the dose_events row only appears when a dose
    // STARTS (queued items are invisible), exactly like production. The
    // engine starts busy with a 25-minute manual alk dose, so the first
    // submitted catch-ups start LATE — after their planned anchor — the
    // exact shape of the 1m47s-apart incident.
    const start = new Date('2026-10-02T09:00:00Z');
    vi.setSystemTime(start);

    const repo = new FakeMissedDosesRepository();
    const engine = new SerialCatchupEngine(repo, 2 * 60 * 1000);
    engine.preloadRunning('alk', start, 25 * 60 * 1000);

    const pumps: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
    const ids: string[] = [];
    for (const pumpId of pumps) {
      for (let i = 0; i < 9; i++) {
        const entry = repo.createMissedDose({
          scheduleId: 'sched-1',
          pumpId,
          scheduledFor: new Date(
            start.getTime() - (40 - i) * 3_600_000,
          ).toISOString(),
          volumeMl: 1,
          status: 'pending',
          deferredUntil: null,
          confirmAfter: null,
        });
        ids.push(entry.id);
      }
    }

    await confirmMissedDoses(repo, engine, ids, start);

    // Drain in one-minute ticks for up to 24 simulated hours.
    const horizon = start.getTime() + 24 * 3_600_000;
    let t = start.getTime();
    while (t < horizon) {
      t += 60_000;
      const now = new Date(t);
      vi.setSystemTime(now);
      engine.step(now);
      await fireScheduledConfirmations(repo, engine, now);
      engine.step(now);
      if (
        !repo.missedDoses.some((m) => m.status === 'confirmed') &&
        !engine.hasPendingWork()
      ) {
        break;
      }
    }

    // Everything fired exactly once and reached a terminal state.
    expect(repo.missedDoses.every((m) => m.status === 'completed')).toBe(true);

    // The invariant: no two doses for the same pump start <30 min apart.
    for (const pumpId of pumps) {
      const starts = repo.events
        .filter(
          (e) => e.pumpId === pumpId && e.source === 'catchup' && e.startedAt,
        )
        .map((e) => new Date(e.startedAt).getTime())
        .sort((a, b) => a - b);
      expect(starts).toHaveLength(9);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(
          30 * 60 * 1000,
        );
      }
    }
  });
});
