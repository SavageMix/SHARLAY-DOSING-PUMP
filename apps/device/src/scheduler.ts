import { getPreviousDueDate, getPumpStaggerOffsetMs } from '@reef/shared';
import type { DoseEvent, DoseSchedule, PumpId } from '@reef/shared';
import {
  detectMissedDoses,
  detectMissedDosesWithUntrustedClock,
  expireStaleMissedDoses,
  fireScheduledConfirmations,
  type MissedDosesRepository,
} from './missed-doses.js';

export interface SchedulerRepository {
  getEnabledSchedules(): DoseSchedule[];
  updateScheduleLastRunAt(id: string, lastRunAt: string): void;
  getScheduleDoseEventsAfter(scheduleId: string, after: string): DoseEvent[];
  getPumpSkipNext(pumpId: PumpId): boolean;
  setPumpSkipNext(pumpId: PumpId, skipNext: boolean): void;
  saveDoseEvent(event: DoseEvent): void;
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
  /** Moment the scheduler was armed. Slots due BEFORE this must never auto-fire. */
  private armedAt: Date | null = null;

  constructor(
    private repository: SchedulerRepository & MissedDosesRepository,
    private engine: SchedulerEngine,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(options: { clockTrusted?: boolean } = {}): void {
    if (this.timer) return;

    const clockTrusted = options.clockTrusted ?? true;
    const now = new Date();
    this.armedAt = now;

    if (clockTrusted) {
      // Find doses missed while the engine was offline and surface them as
      // pending confirmations. This must happen before the scheduler begins firing
      // future doses so we never auto-fire a missed slot.
      detectMissedDoses(this.repository, now);
    } else {
      // The clock is not trusted (e.g., no RTC and NTP not yet available).
      // Treat every scheduled dose since lastRunAt as a missed confirmation
      // instead of firing it; advance lastRunAt to the current (untrusted) time
      // so future ticks only fire doses that become due from here on.
      detectMissedDosesWithUntrustedClock(this.repository, now);
    }

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

    // Fire confirmed catch-up doses whose per-pump spacing delay has passed.
    void fireScheduledConfirmations(this.repository, this.engine, now);

    const schedules = this.repository.getEnabledSchedules();

    for (const schedule of schedules) {
      // The due slot is always derived from the configured wall-clock times
      // (via computeScheduleTimes) — never from when the previous dose
      // actually ran. lastRunAt is only a dedupe marker: it records which
      // slots have already been handled.
      const previousDue = getPreviousDueDate(schedule, now);
      if (!previousDue) continue;

      const lastRun = schedule.lastRunAt
        ? new Date(schedule.lastRunAt)
        : new Date(0);

      // The most recent scheduled occurrence has already been handled.
      if (previousDue <= lastRun) continue;

      // Backstop: a slot that came due BEFORE the scheduler was armed (device
      // was off, or the clock was untrusted at boot) must NEVER auto-fire.
      // Detection surfaces these as pending confirmations; if one still
      // reaches here, surface it ourselves rather than fire it.
      if (this.armedAt && previousDue < this.armedAt) {
        const cutoff = new Date(
          this.armedAt.getTime() - 24 * 60 * 60 * 1000,
        );
        if (previousDue >= cutoff) {
          const exists = this.repository.hasPendingMissedDoseForSlot(
            schedule.id,
            previousDue.toISOString(),
          );
          if (!exists) {
            this.repository.createMissedDose({
              scheduleId: schedule.id,
              pumpId: schedule.pumpId,
              scheduledFor: previousDue.toISOString(),
              volumeMl: schedule.volumeMl,
              status: 'pending',
              deferredUntil: null,
              confirmAfter: null,
            });
          }
        }
        this.repository.updateScheduleLastRunAt(
          schedule.id,
          previousDue.toISOString(),
        );
        continue;
      }

      // Deterministic per-pump stagger: a pump's fire instant is its slot
      // plus a fixed offset by pump index, so pumps sharing a slot never
      // start in the same instant. Computed from the slot every cycle — the
      // offset never accumulates.
      const fireAt = new Date(
        previousDue.getTime() + getPumpStaggerOffsetMs(schedule.pumpId),
      );
      if (now < fireAt) continue;

      // Reconcile against persisted dose_events. If a dose for this schedule
      // already started at or after the slot time, it fired (possibly before
      // a reboot). Advance lastRunAt to the SLOT time (not the actual start
      // time) so the next cycle stays anchored to the wall clock.
      const events = this.repository.getScheduleDoseEventsAfter(
        schedule.id,
        lastRun.toISOString(),
      );

      const firedEvent = events.find(
        (event) => new Date(event.startedAt) >= previousDue,
      );

      if (firedEvent) {
        this.repository.updateScheduleLastRunAt(
          schedule.id,
          previousDue.toISOString(),
        );
        continue;
      }

      // Skip-next: the user deliberately skipped this pump's next occurrence
      // (e.g. after a water change). Record a 'skipped' event so History
      // shows it was intentional, clear the flag (exactly one dose skipped),
      // and do NOT fire. The flag survives until a real (unfired) occurrence
      // passes — if the dose already fired, the reconcile above kept it.
      if (this.repository.getPumpSkipNext(schedule.pumpId)) {
        const skippedAt = now.toISOString();
        this.repository.saveDoseEvent({
          id: crypto.randomUUID(),
          pumpId: schedule.pumpId,
          requestedMl: schedule.volumeMl,
          actualMl: null,
          status: 'skipped',
          source: 'schedule',
          scheduleId: schedule.id,
          startedAt: skippedAt,
          finishedAt: skippedAt,
          error: null,
        });
        this.repository.setPumpSkipNext(schedule.pumpId, false);
        console.log(
          `[scheduler] Skip-next active for ${schedule.pumpId} — slot ${previousDue.toISOString()} not dosed`,
        );
        this.repository.updateScheduleLastRunAt(
          schedule.id,
          previousDue.toISOString(),
        );
        continue;
      }

      // Fire the scheduled dose and record the exact slot as handled.
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
