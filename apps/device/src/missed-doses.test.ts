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
  detectMissedDoses,
  dismissMissedDose,
  expireStaleMissedDoses,
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

  getPendingMissedDoses(): MissedDose[] {
    return this.missedDoses.filter((m) => m.status === 'pending');
  }

  getMissedDoseById(id: string): MissedDose | undefined {
    return this.missedDoses.find((m) => m.id === id);
  }

  updateMissedDoseStatus(id: string, status: MissedDoseStatus): void {
    const missed = this.missedDoses.find((m) => m.id === id);
    if (missed) missed.status = status;
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
    return this.missedDoses.some(
      (m) =>
        m.scheduleId === scheduleId &&
        m.scheduledFor === scheduledFor &&
        m.status === 'pending',
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
      createdAt: '2026-08-23T09:30:00.000Z',
    });

    expireStaleMissedDoses(repo, now);

    expect(repo.missedDoses[0].status).toBe('pending');
  });
});
