import { getPreviousDueDate } from '@reef/shared';
import type { DoseEvent, DoseSchedule, PumpId } from '@reef/shared';
import {
  detectMissedDoses,
  expireStaleMissedDoses,
  type MissedDosesRepository,
} from './missed-doses.js';

export interface SchedulerRepository {
  getEnabledSchedules(): DoseSchedule[];
  updateScheduleLastRunAt(id: string, lastRunAt: string): void;
  getScheduleDoseEventsAfter(scheduleId: string, after: string): DoseEvent[];
}

export interface SchedulerEngine {
  submitDose(
    pumpId: PumpId,
    amountMl: number,
    source: 'schedule',
    scheduleId: string,
  ): Promise<string>;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private repository: SchedulerRepository & MissedDosesRepository,
    private engine: SchedulerEngine,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    // Find doses missed while the engine was offline and surface them as
    // pending confirmations. This must happen before the scheduler begins firing
    // future doses so we never auto-fire a missed slot.
    detectMissedDoses(this.repository, new Date());
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Run an immediate first check so we don't wait up to 30s after startup.
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(): void {
    const now = new Date();

    // Expire stale missed-dose confirmations. Pending confirmations never block
    // the schedule; the scheduler continues to fire every future due dose.
    expireStaleMissedDoses(this.repository, now);

    const schedules = this.repository.getEnabledSchedules();

    for (const schedule of schedules) {
      const previousDue = getPreviousDueDate(schedule, now);
      if (!previousDue) continue;

      const lastRun = schedule.lastRunAt
        ? new Date(schedule.lastRunAt)
        : new Date(0);

      // The most recent scheduled occurrence has already been handled.
      if (previousDue <= lastRun) continue;

      // Reconcile against persisted dose_events. If a dose for this schedule
      // already started at or after the previous due time, it fired (possibly
      // before a reboot). Update lastRunAt and skip firing.
      const events = this.repository.getScheduleDoseEventsAfter(
        schedule.id,
        lastRun.toISOString(),
      );

      const firedEvent = events.find(
        (event) => new Date(event.startedAt) >= previousDue,
      );

      if (firedEvent) {
        this.repository.updateScheduleLastRunAt(schedule.id, firedEvent.startedAt);
        continue;
      }

      // Fire the scheduled dose and advance lastRunAt to the due time.
      void this.engine.submitDose(
        schedule.pumpId,
        schedule.volumeMl,
        'schedule',
        schedule.id,
      );
      this.repository.updateScheduleLastRunAt(
        schedule.id,
        previousDue.toISOString(),
      );
    }
  }
}

export function createScheduler(
  repository: SchedulerRepository & MissedDosesRepository,
  engine: SchedulerEngine,
  intervalMs?: number,
): Scheduler {
  return new Scheduler(repository, engine, intervalMs);
}
