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
  getPendingMissedDoses(now: Date): MissedDose[];
  getMissedDoseById(id: string): MissedDose | undefined;
  updateMissedDoseStatus(id: string, status: MissedDoseStatus): void;
  snoozePendingMissedDoses(until: string): void;
  setMissedDoseConfirmAfter(id: string, confirmAfter: string | null): void;
  getDueScheduledConfirmations(now: Date): MissedDose[];
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
          deferredUntil: null,
          confirmAfter: null,
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
          deferredUntil: null,
          confirmAfter: null,
        });
      }

      repository.updateScheduleLastRunAt(schedule.id, dueDate.toISOString());
    }
  }
}

// ---------------------------------------------------------------------------
// Snooze, batch confirm, and deferred catch-up firing
// ---------------------------------------------------------------------------

/** Default "Decide later" snooze: 1 hour. */
const DEFAULT_SNOOZE_MINUTES = 60;

/**
 * Minimum spacing between catch-up doses for the same pump. There is no
 * per-pump interval setting yet, so the specified fallback of 30 min applies.
 */
const CATCH_UP_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * "Decide later": hide every pending entry until `until`. The entries stay
 * pending on the device (source of truth), so the snooze survives app
 * restarts and works identically on web and native. Once the horizon passes,
 * the entries reappear from GET /api/missed-doses.
 */
export function snoozeMissedDoses(
  repository: MissedDosesRepository,
  now: Date,
  until?: Date,
): string {
  const horizon = until ?? new Date(now.getTime() + DEFAULT_SNOOZE_MINUTES * 60 * 1000);
  repository.snoozePendingMissedDoses(horizon.toISOString());
  return horizon.toISOString();
}

/**
 * Batch-confirm selected catch-up doses.
 *
 * Per pump, doses are ordered by scheduled time. The first is submitted to
 * the engine immediately; each subsequent one is confirmed but delayed by the
 * per-pump minimum interval (confirmAfter), so catch-up doses never fire
 * back-to-back. Doses that would violate the single-dose or daily cap are NOT
 * fired: they are dropped (dismissed, so they never resurface) and reported.
 */
export async function confirmMissedDoses(
  repository: MissedDosesRepository,
  engine: MissedDosesEngine,
  ids: string[],
  now: Date,
): Promise<{ fired: string[]; scheduled: string[]; dropped: Array<{ id: string; reason: string }> }> {
  const entries: MissedDose[] = [];
  for (const id of ids) {
    const missed = repository.getMissedDoseById(id);
    if (!missed) throw new Error(`Missed dose ${id} not found`);
    if (missed.status !== 'pending') {
      throw new Error(`Missed dose is ${missed.status}`);
    }
    entries.push(missed);
  }

  const limits = computeDoseLimits(repository.getSystemVolumeLitres());
  const fired: string[] = [];
  const scheduled: string[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];

  // Group per pump, oldest slot first.
  const byPump = new Map<PumpId, MissedDose[]>();
  for (const entry of entries) {
    const list = byPump.get(entry.pumpId) ?? [];
    list.push(entry);
    byPump.set(entry.pumpId, list);
  }

  for (const [pumpId, list] of byPump) {
    list.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    let usedTodayMl = repository.getTodayDoseMl(pumpId);
    // Next allowed fire instant for this pump (first dose fires immediately).
    let nextFireAt = now.getTime();

    for (const entry of list) {
      if (entry.volumeMl > limits.maxSingleDoseMl) {
        repository.updateMissedDoseStatus(entry.id, 'dismissed');
        dropped.push({
          id: entry.id,
          reason: `Exceeds single-dose limit (${limits.maxSingleDoseMl.toFixed(2)} mL)`,
        });
        continue;
      }
      if (usedTodayMl + entry.volumeMl > limits.maxDailyDoseMlPerPump) {
        repository.updateMissedDoseStatus(entry.id, 'dismissed');
        dropped.push({
          id: entry.id,
          reason: `Would exceed today's limit (${limits.maxDailyDoseMlPerPump.toFixed(2)} mL)`,
        });
        continue;
      }

      if (nextFireAt <= now.getTime()) {
        await engine.submitDose(pumpId, entry.volumeMl, 'schedule', entry.scheduleId);
        repository.updateMissedDoseStatus(entry.id, 'confirmed');
        repository.setMissedDoseConfirmAfter(entry.id, null);
        fired.push(entry.id);
      } else {
        // Confirmed now (so it can never re-nag), fired once confirmAfter passes.
        repository.updateMissedDoseStatus(entry.id, 'confirmed');
        repository.setMissedDoseConfirmAfter(
          entry.id,
          new Date(nextFireAt).toISOString(),
        );
        scheduled.push(entry.id);
      }

      usedTodayMl += entry.volumeMl;
      nextFireAt += CATCH_UP_MIN_INTERVAL_MS;
    }
  }

  return { fired, scheduled, dropped };
}

/**
 * Fire catch-up doses whose spacing delay has passed. Called on every
 * scheduler tick. Caps are re-checked at fire time; a dose that no longer fits
 * is dropped (dismissed) rather than fired, since the user already decided.
 */
export async function fireScheduledConfirmations(
  repository: MissedDosesRepository,
  engine: MissedDosesEngine,
  now: Date,
): Promise<void> {
  const due = repository.getDueScheduledConfirmations(now);
  for (const entry of due) {
    const limits = computeDoseLimits(repository.getSystemVolumeLitres());
    const todayMl = repository.getTodayDoseMl(entry.pumpId);

    if (
      entry.volumeMl > limits.maxSingleDoseMl ||
      todayMl + entry.volumeMl > limits.maxDailyDoseMlPerPump
    ) {
      repository.updateMissedDoseStatus(entry.id, 'dismissed');
      repository.setMissedDoseConfirmAfter(entry.id, null);
      console.warn(
        `[missed-doses] Dropped deferred dose ${entry.id} (${entry.pumpId}): would exceed safety caps`,
      );
      continue;
    }

    await engine.submitDose(entry.pumpId, entry.volumeMl, 'schedule', entry.scheduleId);
    repository.setMissedDoseConfirmAfter(entry.id, null);
  }
}
