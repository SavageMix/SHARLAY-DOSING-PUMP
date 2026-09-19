import { computeDoseLimits, getMissedDueDates, getPreviousDueDate } from '@reef/shared';
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
  /**
   * Most recent COMPLETED dose event for a pump across ALL sources
   * (schedule, catchup, manual, prime), as ISO started_at — drives the
   * shared catch-up eligibility gate.
   */
  getLastCompletedDoseAt(pumpId: PumpId): string | null;
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
    source: 'schedule' | 'catchup',
    scheduleId: string,
    missedDoseId?: string | null,
  ): Promise<string>;
}

/**
 * A slot counts as handled only when its event actually delivered ('completed')
 * or was deliberately not dosed ('skipped'). 'interrupted', 'failed', 'aborted'
 * or unfinished events under-delivered — the slot must be treated
 * conservatively (missed → pending confirmation), never as fired.
 */
export function isSlotHandled(event: DoseEvent): boolean {
  return event.status === 'completed' || event.status === 'skipped';
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

    if (!lastRunAt) {
      // No anchor (schedule never ran, or lastRunAt was lost). The most
      // recent slot before now passed while the device was off or not yet
      // running — it must become a pending confirmation (if within the
      // lookback), never an auto-fire. Arm lastRunAt at that slot so the
      // scheduler only fires slots that come due after arming.
      armScheduleAtPreviousDue(repository, schedule, now, cutoff);
      continue;
    }

    const missedDueDates = getMissedDueDates(schedule, lastRunAt, now);

    for (const dueDate of missedDueDates) {
      const after = new Date(dueDate.getTime() - 1).toISOString();
      const events = repository.getScheduleDoseEventsAfter(
        schedule.id,
        after,
      );
      const firedEvent = events.find(
        (event) =>
          isSlotHandled(event) && new Date(event.startedAt) >= dueDate,
      );

      if (firedEvent) {
        // Advance to the SLOT time, never the actual start time — detection
        // must stay anchored to the wall-clock schedule.
        repository.updateScheduleLastRunAt(
          schedule.id,
          dueDate.toISOString(),
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
 * and the missed dose remains pending. Once the dose physically finishes, the
 * engine closes the entry to a terminal state (completed/failed/interrupted)
 * in the same transaction as the dose event — a confirmed entry can therefore
 * never be eligible to re-fire.
 */
export async function confirmMissedDose(
  repository: MissedDosesRepository,
  engine: MissedDosesEngine,
  id: string,
): Promise<string | null> {
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

  // Mark confirmed BEFORE submitting: the engine closes the entry to its
  // terminal state (completed/failed/interrupted) when the dose physically
  // finishes — a status write racing after that would resurrect it.
  repository.updateMissedDoseStatus(id, 'confirmed');

  // Shared per-pump eligibility gate: if the pump dosed recently (any
  // source), this catch-up must wait rather than fire early. It stays
  // confirmed with confirmAfter set, and the queue-drain tick fires it once
  // the pump's last dose is old enough. Never dropped, never fired early.
  const now = new Date();
  if (!isCatchupFireEligible(repository, missed.pumpId, now)) {
    const eligibleAt = nextCatchupEligibleAt(repository, missed.pumpId, now);
    repository.setMissedDoseConfirmAfter(
      id,
      new Date(eligibleAt).toISOString(),
    );
    return null;
  }

  const jobId = await engine.submitDose(
    missed.pumpId,
    missed.volumeMl,
    'catchup',
    missed.scheduleId,
    missed.id,
  );

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

    if (!lastRunAt) {
      // No anchor: the most recent slot before now was missed under an
      // untrusted clock. Surface it as a pending confirmation and arm
      // lastRunAt at that slot so the scheduler never auto-fires it.
      armScheduleAtPreviousDue(repository, schedule, now);
      continue;
    }

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

/**
 * Arm a schedule that has no lastRunAt anchor (never ran, or the anchor was
 * lost). The most recent slot before `now` is treated as missed — pending
 * confirmation, never auto-fire — if it is within `cutoff` (when given), and
 * lastRunAt is advanced to that slot so the scheduler only fires slots that
 * come due afterwards. If a dose already delivered for the slot (or it was
 * deliberately skipped), only the anchor is restored.
 */
function armScheduleAtPreviousDue(
  repository: MissedDosesRepository,
  schedule: DoseSchedule,
  now: Date,
  cutoff?: Date,
): void {
  const previousDue = getPreviousDueDate(schedule, now);
  if (!previousDue) return;

  const after = new Date(previousDue.getTime() - 1).toISOString();
  const firedEvent = repository
    .getScheduleDoseEventsAfter(schedule.id, after)
    .find(
      (event) =>
        isSlotHandled(event) && new Date(event.startedAt) >= previousDue,
    );

  if (!firedEvent && (!cutoff || previousDue >= cutoff)) {
    const exists = repository.hasPendingMissedDoseForSlot(
      schedule.id,
      previousDue.toISOString(),
    );
    if (!exists) {
      repository.createMissedDose({
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

  repository.updateScheduleLastRunAt(schedule.id, previousDue.toISOString());
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
 * The single per-pump eligibility gate consulted at EVERY catch-up fire
 * point — single confirmation, batch confirmation, and the queue-drain tick
 * (which also covers boot). A catch-up may fire only when the pump's most
 * recent COMPLETED dose event — of ANY source: schedule, catchup, manual,
 * prime — is at least CATCH_UP_MIN_INTERVAL_MS old. Anything else led to
 * production incidents: same-pump catch-ups minutes apart and catch-ups
 * landing right before a scheduled dose because eligibility was computed
 * from per-entry anchors instead of the pump's actual dosing history.
 */
export function isCatchupFireEligible(
  repository: Pick<MissedDosesRepository, 'getLastCompletedDoseAt'>,
  pumpId: PumpId,
  now: Date,
): boolean {
  const lastIso = repository.getLastCompletedDoseAt(pumpId);
  if (!lastIso) return true;
  return (
    now.getTime() - new Date(lastIso).getTime() >= CATCH_UP_MIN_INTERVAL_MS
  );
}

/**
 * The next instant a catch-up may fire for this pump given its actual dosing
 * history (now, when the pump has never dosed).
 */
function nextCatchupEligibleAt(
  repository: Pick<MissedDosesRepository, 'getLastCompletedDoseAt'>,
  pumpId: PumpId,
  now: Date,
): number {
  const lastIso = repository.getLastCompletedDoseAt(pumpId);
  if (!lastIso) return now.getTime();
  return Math.max(
    now.getTime(),
    new Date(lastIso).getTime() + CATCH_UP_MIN_INTERVAL_MS,
  );
}

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
    // First fire instant for this pump: anchored to the pump's ACTUAL last
    // completed dose (any source), not to `now` — a scheduled/manual dose 5
    // minutes ago means the first catch-up waits the full 30 min from that
    // dose. The queue-drain gate re-verifies this at fire time.
    let nextFireAt = nextCatchupEligibleAt(repository, pumpId, now);

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
        // Mark confirmed BEFORE submitting (see confirmMissedDose).
        repository.updateMissedDoseStatus(entry.id, 'confirmed');
        repository.setMissedDoseConfirmAfter(entry.id, null);
        await engine.submitDose(
          pumpId,
          entry.volumeMl,
          'catchup',
          entry.scheduleId,
          entry.id,
        );
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
    // Shared per-pump eligibility gate (measured from the pump's actual last
    // completed dose of ANY source). Not eligible yet → the entry stays
    // queued — confirmed, confirmAfter unchanged — and is re-checked on the
    // next tick. Never dropped, never fired early.
    if (!isCatchupFireEligible(repository, entry.pumpId, now)) {
      continue;
    }

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

    await engine.submitDose(
      entry.pumpId,
      entry.volumeMl,
      'catchup',
      entry.scheduleId,
      entry.id,
    );
    // The engine closes the entry to a terminal state (completed/failed/
    // interrupted) atomically with the dose event; clearing confirmAfter here
    // only ensures the entry is not re-selected while the dose is in flight.
    repository.setMissedDoseConfirmAfter(entry.id, null);
  }
}
