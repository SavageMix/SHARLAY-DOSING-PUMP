import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoseEvent, DoseSchedule, PumpId } from '@reef/shared';
import { Scheduler, type SchedulerEngine, type SchedulerRepository } from '../src/scheduler.js';

class FakeSchedulerRepository implements SchedulerRepository {
  schedules: DoseSchedule[] = [];
  events: DoseEvent[] = [];

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
