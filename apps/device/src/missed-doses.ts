import { computeDoseLimits, getMissedDueDates } from '@reef/shared';
import type {
  DoseEvent,
  DoseSchedule,
  MissedDose,
  MissedDoseStatus,
  PumpId,
} from '@reef/shared';

export type { MissedDose, MissedDoseStatus };

export interface MissedDosesRepository {
  getEnabledSchedules(): DoseSchedule[];
  getScheduleDoseEventsAfter(scheduleId: string, after: string): DoseEvent[];
  updateScheduleLastRunAt(id: string, lastRunAt: string): void;
  getSystemVolumeLitres(): number;
  getTodayDoseMl(pumpId: PumpId): number;
  createMissedDose(
    missed: Omit<MissedDose, 'id' | 'createdAt'>,
  ): MissedDose;
  getPendingMissedDoses(): MissedDose[];
  getMissedDoseById(id: string): MissedDose | undefined;
  updateMissedDoseStatus(id: string, status: MissedDoseStatus): void;
  expireMissedDosesBefore(threshold: string): void;
  hasPendingMissedDoseForSlot(
    scheduleId: string,
    scheduledFor: string,
  ): boolean;
}

export interface MissedDosesEngine {
  submitDose(
    pumpId: PumpId,
    amountMl: number,
    source: 'schedule',
    scheduleId: string,
  ): Promise<string>;
}

const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Find scheduled occurrences that were missed while the engine was not running.
 * For each enabled schedule, walk forward from lastRunAt. Any due slot without a
 * matching dose_event becomes a pending missed_dose (if within the lookback window)
 * or is silently forgotten (if older). lastRunAt is advanced so these slots are not
 * re-detected on the next run.
 */
export function detectMissedDoses(
  repository: MissedDosesRepository,
  now: Date,
  lookbackHours: number = DEFAULT_LOOKBACK_HOURS,
): void {
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const schedules = repository.getEnabledSchedules();

  for (const schedule of schedules) {
    const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    if (!lastRunAt) continue;

    const missedDueDates = getMissedDueDates(schedule, lastRunAt, now);

    for (const dueDate of missedDueDates) {
      const after = new Date(dueDate.getTime() - 1).toISOString();
      const events = repository.getScheduleDoseEventsAfter(
        schedule.id,
        after,
      );
      const firedEvent = events.find(
        (event) => new Date(event.startedAt) >= dueDate,
      );

      if (firedEvent) {
        repository.updateScheduleLastRunAt(
          schedule.id,
          new Date(firedEvent.startedAt).toISOString(),
        );
        continue;
      }

      if (dueDate < cutoff) {
        // Older than lookback: forget and advance.
        repository.updateScheduleLastRunAt(
          schedule.id,
          dueDate.toISOString(),
        );
        continue;
      }

      const exists = repository.hasPendingMissedDoseForSlot(
        schedule.id,
        dueDate.toISOString(),
      );
      if (!exists) {
        repository.createMissedDose({
          scheduleId: schedule.id,
          pumpId: schedule.pumpId,
          scheduledFor: dueDate.toISOString(),
          volumeMl: schedule.volumeMl,
          status: 'pending',
        });
      }

      repository.updateScheduleLastRunAt(schedule.id, dueDate.toISOString());
    }
  }
}

/**
 * Confirm a pending missed dose. The dose is submitted through the normal engine
 * path with all safety caps enforced. If it would exceed limits, it is rejected
 * and the missed dose remains pending.
 */
export async function confirmMissedDose(
  repository: MissedDosesRepository,
  engine: MissedDosesEngine,
  id: string,
): Promise<string> {
  const missed = repository.getMissedDoseById(id);
  if (!missed) {
    throw new Error(`Missed dose ${id} not found`);
  }
  if (missed.status !== 'pending') {
    throw new Error(`Missed dose is ${missed.status}`);
  }

  const systemVolumeLitres = repository.getSystemVolumeLitres();
  const limits = computeDoseLimits(systemVolumeLitres);

  if (missed.volumeMl > limits.maxSingleDoseMl) {
    throw new Error(
      `Dose ${missed.volumeMl}mL exceeds single-dose limit ${limits.maxSingleDoseMl.toFixed(2)}mL`,
    );
  }

  const todayMl = repository.getTodayDoseMl(missed.pumpId);
  if (todayMl + missed.volumeMl > limits.maxDailyDoseMlPerPump) {
    throw new Error(
      `Daily total for ${missed.pumpId} would exceed ${limits.maxDailyDoseMlPerPump.toFixed(2)}mL`,
    );
  }

  const jobId = await engine.submitDose(
    missed.pumpId,
    missed.volumeMl,
    'schedule',
    missed.scheduleId,
  );

  repository.updateMissedDoseStatus(id, 'confirmed');
  return jobId;
}

export function dismissMissedDose(
  repository: MissedDosesRepository,
  id: string,
): void {
  const missed = repository.getMissedDoseById(id);
  if (!missed) {
    throw new Error(`Missed dose ${id} not found`);
  }
  if (missed.status !== 'pending') {
    throw new Error(`Missed dose is ${missed.status}`);
  }
  repository.updateMissedDoseStatus(id, 'dismissed');
}

export function expireStaleMissedDoses(
  repository: MissedDosesRepository,
  now: Date,
  lookbackHours: number = DEFAULT_LOOKBACK_HOURS,
): void {
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  repository.expireMissedDosesBefore(cutoff.toISOString());
}

/**
 * Untrusted-clock variant of missed-dose detection.
 *
 * When the device boots without a real-time clock and NTP has not yet
 * synchronized, we cannot trust the wall clock. We therefore conservatively
 * treat EVERY scheduled slot since lastRunAt as a missed confirmation rather
 * than risk firing doses based on a fake-hwclock timestamp. lastRunAt is
 * advanced to the current untrusted time so the scheduler only fires doses that
 * become due from this point forward.
 */
export function detectMissedDosesWithUntrustedClock(
  repository: MissedDosesRepository,
  now: Date,
): void {
  const schedules = repository.getEnabledSchedules();

  for (const schedule of schedules) {
    const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    if (!lastRunAt) continue;

    const missedDueDates = getMissedDueDates(schedule, lastRunAt, now);

    for (const dueDate of missedDueDates) {
      const exists = repository.hasPendingMissedDoseForSlot(
        schedule.id,
        dueDate.toISOString(),
      );
      if (!exists) {
        repository.createMissedDose({
          scheduleId: schedule.id,
          pumpId: schedule.pumpId,
          scheduledFor: dueDate.toISOString(),
          volumeMl: schedule.volumeMl,
          status: 'pending',
        });
      }

      repository.updateScheduleLastRunAt(schedule.id, dueDate.toISOString());
    }
  }
}
