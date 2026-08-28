import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoseEvent, DoseSchedule, MissedDose, MissedDoseStatus, PumpId } from '@reef/shared';
import { Scheduler, type SchedulerEngine, type SchedulerRepository } from '../src/scheduler.js';
import type { MissedDosesRepository } from '../src/missed-doses.js';

class FakeSchedulerRepository implements SchedulerRepository, MissedDosesRepository {
  schedules: DoseSchedule[] = [];
  events: DoseEvent[] = [];
  missedDoses: MissedDose[] = [];

  getEnabledSchedules(): DoseSchedule[] {
    return this.schedules.filter((s) => s.enabled);
  }

  updateScheduleLastRunAt(id: string, lastRunAt: string): void {
    const schedule = this.schedules.find((s) => s.id === id);
    if (schedule) schedule.lastRunAt = lastRunAt;
  }

  getScheduleDoseEventsAfter(scheduleId: string, after: string): DoseEvent[] {
    return this.events.filter(
      (event) =>
        event.scheduleId === scheduleId && event.startedAt > after,
    );
  }

  getSystemVolumeLitres(): number {
    return 380;
  }

  getTodayDoseMl(): number {
    return 0;
  }

  createMissedDose(missed: Omit<MissedDose, 'id' | 'createdAt'>): MissedDose {
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

  hasPendingMissedDoseForSlot(scheduleId: string, scheduledFor: string): boolean {
    return this.missedDoses.some(
      (m) =>
        m.scheduleId === scheduleId &&
        m.scheduledFor === scheduledFor &&
        m.status === 'pending',
    );
  }
}

function createFakeEngine(): SchedulerEngine {
  return {
    submitDose: vi.fn().mockResolvedValue('job-id'),
  };
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

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  it('fires a due schedule', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: null,
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    expect(engine.submitDose).toHaveBeenCalledWith(
      'alk',
      1,
      'schedule',
      'sched-1',
    );
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T09:00:00.000Z');
  });

  it('does not double-fire after reboot when a dose_event already exists', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        // lastRunAt was not persisted before the power cut.
        lastRunAt: '2026-08-22T09:00:00.000Z',
      }),
    );

    // A dose already ran for today's 09:00 occurrence but lastRunAt was lost.
    repo.events.push({
      id: 'event-1',
      pumpId: 'alk',
      requestedMl: 1,
      actualMl: 1,
      status: 'completed',
      source: 'schedule',
      scheduleId: 'sched-1',
      startedAt: '2026-08-23T09:00:05.000Z',
      finishedAt: '2026-08-23T09:00:06.000Z',
      error: null,
    });

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    expect(engine.submitDose).not.toHaveBeenCalled();
    // Scheduler should reconcile lastRunAt from the persisted event.
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T09:00:05.000Z');
  });

  it('never fires a disabled schedule', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        enabled: false,
        lastRunAt: null,
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.schedules[0].lastRunAt).toBeNull();
  });

  it('does not fire again if lastRunAt already covers the previous due time', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-23T09:00:00.000Z',
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    expect(engine.submitDose).not.toHaveBeenCalled();
  });

  it('still fires the next scheduled dose while a missed-dose confirmation is pending', () => {
    vi.setSystemTime(new Date('2026-08-24T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        // Last ran on 23rd; today's 09:00 slot was missed and is pending confirmation.
        lastRunAt: '2026-08-23T09:00:00.000Z',
      }),
    );
    repo.missedDoses.push({
      id: 'missed-1',
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-24T09:00:00.000Z',
      volumeMl: 1,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    // The next scheduled dose must fire automatically despite the pending confirmation.
    expect(engine.submitDose).toHaveBeenCalledWith(
      'alk',
      1,
      'schedule',
      'sched-1',
    );
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-24T09:00:00.000Z');
    expect(repo.missedDoses[0].status).toBe('pending');
  });

  it('advances lastRunAt to the previous due time even if no event fired', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: null,
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    expect(engine.submitDose).toHaveBeenCalledOnce();
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T09:00:00.000Z');
  });
});
