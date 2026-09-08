// These fixtures use absolute UTC timestamps (e.g. setSystemTime with a "Z"
// string) and assert absolute UTC outcomes. Schedule times are interpreted as
// device-local wall clock, so pin the process TZ to UTC to keep local == UTC
// and the fixtures unambiguous on any machine.
process.env.TZ = 'UTC';

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

  hasPendingMissedDoseForSlot(scheduleId: string, scheduledFor: string): boolean {
    // Dedupe spans ALL statuses: a dismissed/expired/confirmed slot must never
    // resurface as a fresh pending entry.
    return this.missedDoses.some(
      (m) => m.scheduleId === scheduleId && m.scheduledFor === scheduledFor,
    );
  }

  skipNextPumps = new Set<PumpId>();

  getPumpSkipNext(pumpId: PumpId): boolean {
    return this.skipNextPumps.has(pumpId);
  }

  setPumpSkipNext(pumpId: PumpId, skipNext: boolean): void {
    if (skipNext) {
      this.skipNextPumps.add(pumpId);
    } else {
      this.skipNextPumps.delete(pumpId);
    }
  }

  saveDoseEvent(event: DoseEvent): void {
    this.events.push(event);
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
    // Scheduler should reconcile lastRunAt to the exact scheduled slot (not
    // the actual event start time) so the schedule never drifts.
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T09:00:00.000Z');
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
      deferredUntil: null,
      confirmAfter: null,
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

  it('with an untrusted clock, treats intervening scheduled doses as missed instead of firing them', () => {
    vi.setSystemTime(new Date('2026-08-29T10:00:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-28T09:00:00.000Z',
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.start({ clockTrusted: false });

    // The 09:00 slot on 29 Aug appears overdue because the untrusted clock
    // says it is 10:00. It must be surfaced as a pending confirmation, not
    // fired automatically.
    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.missedDoses).toHaveLength(1);
    expect(repo.missedDoses[0]).toMatchObject({
      scheduleId: 'sched-1',
      pumpId: 'alk',
      scheduledFor: '2026-08-29T09:00:00.000Z',
      status: 'pending',
    });
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-29T09:00:00.000Z');
  });

  it('after untrusted-clock startup, future scheduled doses still fire normally', () => {
    vi.setSystemTime(new Date('2026-08-29T10:00:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-28T09:00:00.000Z',
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    // Boot with untrusted clock: the 29 Aug 09:00 slot becomes a pending
    // confirmation and lastRunAt advances to that time.
    scheduler.start({ clockTrusted: false });
    expect(engine.submitDose).not.toHaveBeenCalled();

    // Clock later becomes correct / NTP syncs; the next day's 09:00 slot fires
    // exactly once.
    vi.setSystemTime(new Date('2026-08-30T09:30:00Z'));
    scheduler.tick();

    expect(engine.submitDose).toHaveBeenCalledWith(
      'alk',
      1,
      'schedule',
      'sched-1',
    );
    expect(engine.submitDose).toHaveBeenCalledOnce();
  });
});

describe('wall-clock anchoring (no drift)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  it('anchors lastRunAt to the exact slot, not the actual run time, across repeated firings', () => {
    vi.setSystemTime(new Date('2026-08-23T06:00:30Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '06:00',
        timesPerDay: 2,
        lastRunAt: null,
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T06:00:00.000Z');

    // Simulate a late completion (06:01:15) and a reboot with a stale
    // lastRunAt: the reconcile must record the SLOT time, not 06:01:15.
    repo.events.push({
      id: 'event-1',
      pumpId: 'alk',
      requestedMl: 1,
      actualMl: 1,
      status: 'completed',
      source: 'schedule',
      scheduleId: 'sched-1',
      startedAt: '2026-08-23T06:01:15.000Z',
      finishedAt: '2026-08-23T06:01:16.000Z',
      error: null,
    });
    repo.updateScheduleLastRunAt('sched-1', '2026-08-22T18:00:00.000Z');
    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(1); // not re-fired
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T06:00:00.000Z');

    // Every subsequent cycle fires at the exact configured wall-clock slot,
    // regardless of when the previous dose completed.
    vi.setSystemTime(new Date('2026-08-23T18:00:30Z'));
    scheduler.tick();
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T18:00:00.000Z');

    vi.setSystemTime(new Date('2026-08-24T06:00:30Z'));
    scheduler.tick();
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-24T06:00:00.000Z');

    expect(engine.submitDose).toHaveBeenCalledTimes(3);
  });
});

describe('per-pump stagger', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  it('same-time schedules fire offset by pump index, never in the same instant', () => {
    vi.setSystemTime(new Date('2026-08-23T06:00:30Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({ id: 'sched-alk', pumpId: 'alk', startTime: '06:00', lastRunAt: null }),
      makeSchedule({ id: 'sched-ca', pumpId: 'ca', startTime: '06:00', lastRunAt: null }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();
    // alk (index 0, offset 0) fires; ca (index 1, +90 s) must not fire yet.
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
    expect(engine.submitDose).toHaveBeenCalledWith('alk', 1, 'schedule', 'sched-alk');
    expect(repo.schedules[1].lastRunAt).toBeNull();

    vi.setSystemTime(new Date('2026-08-23T06:01:00Z'));
    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-23T06:01:31Z'));
    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(2);
    expect(engine.submitDose).toHaveBeenLastCalledWith('ca', 1, 'schedule', 'sched-ca');

    // Next day the offsets are identical — the stagger never accumulates.
    vi.setSystemTime(new Date('2026-08-24T06:00:30Z'));
    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(3);
    expect(engine.submitDose).toHaveBeenLastCalledWith('alk', 1, 'schedule', 'sched-alk');

    vi.setSystemTime(new Date('2026-08-24T06:01:31Z'));
    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(4);
    expect(engine.submitDose).toHaveBeenLastCalledWith('ca', 1, 'schedule', 'sched-ca');
  });
});

describe('boot arming (missed slots never auto-fire)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  it('untrusted clock: an overdue slot with no lastRunAt becomes pending, never fires', () => {
    // The hardware incident: NTP gate timed out at ~10:28:24 and the scheduler
    // auto-fired the missed 10:25 slot in the same second.
    vi.setSystemTime(new Date('2026-08-23T10:28:24Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '10:25',
        lastRunAt: null,
      }),
    );

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);
    scheduler.start({ clockTrusted: false });
    try {
      expect(engine.submitDose).not.toHaveBeenCalled();
      expect(repo.missedDoses).toHaveLength(1);
      expect(repo.missedDoses[0]).toMatchObject({
        scheduleId: 'sched-1',
        scheduledFor: '2026-08-23T10:25:00.000Z',
        status: 'pending',
      });
      expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T10:25:00.000Z');

      // The NEXT day's slot — due after arming — fires normally.
      vi.setSystemTime(new Date('2026-08-24T10:25:31Z'));
      scheduler.tick();
      expect(engine.submitDose).toHaveBeenCalledTimes(1);
      expect(engine.submitDose).toHaveBeenCalledWith('alk', 1, 'schedule', 'sched-1');
    } finally {
      scheduler.stop();
    }
  });

  it('trusted clock: an overdue slot with no lastRunAt at arm time becomes pending, never fires', () => {
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
    scheduler.start(); // trusted clock
    try {
      expect(engine.submitDose).not.toHaveBeenCalled();
      expect(repo.missedDoses).toHaveLength(1);
      expect(repo.missedDoses[0]).toMatchObject({
        scheduledFor: '2026-08-23T09:00:00.000Z',
        status: 'pending',
      });

      // Slot due after arming fires normally.
      vi.setSystemTime(new Date('2026-08-24T09:00:31Z'));
      scheduler.tick();
      expect(engine.submitDose).toHaveBeenCalledTimes(1);
      expect(engine.submitDose).toHaveBeenCalledWith('alk', 1, 'schedule', 'sched-1');
    } finally {
      scheduler.stop();
    }
  });

  it('backstop: a pre-arm slot reaching the tick fire path becomes missed, not fired', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);
    scheduler.start();
    try {
      // A schedule appears mid-run with a stale lastRunAt (e.g. re-enabled
      // after its slot passed) — detection never ran for it.
      repo.schedules.push(
        makeSchedule({
          id: 'sched-1',
          pumpId: 'alk',
          startTime: '09:00',
          lastRunAt: '2026-08-22T09:00:00.000Z',
        }),
      );

      vi.setSystemTime(new Date('2026-08-23T09:31:00Z'));
      scheduler.tick();

      expect(engine.submitDose).not.toHaveBeenCalled();
      expect(repo.missedDoses).toHaveLength(1);
      expect(repo.missedDoses[0]).toMatchObject({
        scheduledFor: '2026-08-23T09:00:00.000Z',
        status: 'pending',
      });
    } finally {
      scheduler.stop();
    }
  });
});

describe('skip next dose', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  it('skip-next: the occurrence is not fired, a skipped event is recorded, and the flag auto-clears', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '06:00',
        timesPerDay: 2,
        lastRunAt: '2026-08-22T18:00:00.000Z',
      }),
    );
    repo.skipNextPumps.add('alk');

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    // Fired zero times; the skip is recorded for History and the flag clears.
    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.skipNextPumps.has('alk')).toBe(false);
    expect(repo.schedules[0].lastRunAt).toBe('2026-08-23T06:00:00.000Z');
    const skipped = repo.events.filter((e) => e.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      pumpId: 'alk',
      source: 'schedule',
      scheduleId: 'sched-1',
      requestedMl: 1,
      actualMl: null,
    });

    // The following slot fires normally — exactly one dose was skipped.
    vi.setSystemTime(new Date('2026-08-23T18:00:30Z'));
    scheduler.tick();
    expect(engine.submitDose).toHaveBeenCalledTimes(1);
    expect(engine.submitDose).toHaveBeenCalledWith('alk', 1, 'schedule', 'sched-1');
  });

  it('skip then cancel: the occurrence fires normally', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '09:00',
        lastRunAt: '2026-08-22T09:00:00.000Z',
      }),
    );
    repo.skipNextPumps.add('alk');
    repo.skipNextPumps.delete('alk'); // user cancelled the skip before the slot

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();

    expect(engine.submitDose).toHaveBeenCalledTimes(1);
    expect(engine.submitDose).toHaveBeenCalledWith('alk', 1, 'schedule', 'sched-1');
    expect(repo.events.filter((e) => e.status === 'skipped')).toHaveLength(0);
  });

  it('the flag survives a slot that already fired and applies to the next occurrence', () => {
    vi.setSystemTime(new Date('2026-08-23T09:30:00Z'));

    const repo = new FakeSchedulerRepository();
    repo.schedules.push(
      makeSchedule({
        id: 'sched-1',
        pumpId: 'alk',
        startTime: '06:00',
        timesPerDay: 2,
        // The 06:00 slot already fired before the flag was set.
        lastRunAt: '2026-08-23T06:00:00.000Z',
      }),
    );
    repo.skipNextPumps.add('alk');

    const engine = createFakeEngine();
    const scheduler = new Scheduler(repo, engine, 30_000);

    scheduler.tick();
    // 06:00 was already handled — the flag must NOT be consumed by it.
    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.skipNextPumps.has('alk')).toBe(true);

    // It applies to the next unfired occurrence (18:00) instead.
    vi.setSystemTime(new Date('2026-08-23T18:00:30Z'));
    scheduler.tick();
    expect(engine.submitDose).not.toHaveBeenCalled();
    expect(repo.skipNextPumps.has('alk')).toBe(false);
    expect(repo.events.filter((e) => e.status === 'skipped')).toHaveLength(1);
  });
});
