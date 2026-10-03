import { randomUUID } from 'node:crypto';
import { computeDoseLimits, PUMP_STAGGER_MS_PER_INDEX } from '@reef/shared';
import type { DoseEvent, DoseSource, PumpId } from '@reef/shared';
import { driversDisable } from './gpio.js';
import { runSteps } from './stepper.js';

export interface PumpCalibration {
  pumpId: PumpId;
  stepsPerMl: number | null;
}

/**
 * Interface the persistence layer must satisfy. The engine does not care
 * whether this is SQLite, a JSON file, or an in-memory store for tests.
 */
export interface DoseRepository {
  getSystemVolumeLitres(): number | Promise<number>;
  getTodayDoseMl(pumpId: PumpId): number | Promise<number>;
  getPumpCalibration(pumpId: PumpId): PumpCalibration | Promise<PumpCalibration>;
  saveDoseEvent(event: DoseEvent): void | Promise<void>;
  /**
   * OPTIONAL. Persist a finished dose event and, for catch-up doses, close
   * the linked missed_doses entry atomically in the same transaction. When
   * absent, saveDoseEvent is used.
   */
  finalizeDoseEvent?(event: DoseEvent): void | Promise<void>;
  decrementContainer(pumpId: PumpId, amountMl: number): void | Promise<void>;
  /**
   * OPTIONAL. Current status of a missed_doses entry. The engine consults
   * this before starting a catch-up dose so a user cancel that won the race
   * against the queue can never be dosed anyway.
   */
  getMissedDoseStatus?(
    missedDoseId: string,
  ): string | null | Promise<string | null>;
}

interface QueueItem {
  id: string;
  pumpId: PumpId;
  amountMl: number;
  source: DoseSource;
  scheduleId: string | null;
  missedDoseId: string | null;
}

/** Internal sentinel: a catch-up the user cancelled after it left the queue. */
class CancelledBeforeFireError extends Error {}

export interface EngineStatus {
  current: DoseEvent | null;
  queueDepth: number;
}

export interface EngineQueueSnapshotItem {
  pumpId: PumpId;
  amountMl: number;
  source: DoseSource;
  scheduleId: string | null;
  missedDoseId: string | null;
  /** Wall-clock estimate of when this item will start firing. */
  estimatedFireAt: string;
}

export interface EngineOptions {
  /**
   * Minimum gap between the end of one pump run and the start of the next,
   * regardless of trigger source (schedule, catch-up, manual). Reuses the
   * per-pump stagger constant: concurrent or back-to-back dosing is both a
   * chemistry hazard (alk/ca co-dosing) and an electrical one (multiple
   * steppers on one supply).
   */
  minInterDoseGapMs?: number;
  /**
   * Global motor lock. Prime and calibration run their own motor loops
   * OUTSIDE this queue; while either is running the engine must not start a
   * dose (and vice versa — the API refuses prime/calibration while the queue
   * is non-empty, but a scheduled dose can land mid-prime, so the engine
   * polls this before touching the hardware).
   */
  isMotorBusy?: () => boolean;
}

export class Engine {
  private queue: QueueItem[] = [];
  private processing = false;
  private current: DoseEvent | null = null;
  /** Item shifted from the queue but not finished: executing or gap-waiting. */
  private active: QueueItem | null = null;
  private lastRunEndAt: number | null = null;
  private minInterDoseGapMs: number;
  private isMotorBusy?: () => boolean;

  constructor(
    private repository: DoseRepository,
    options: EngineOptions = {},
  ) {
    this.minInterDoseGapMs =
      options.minInterDoseGapMs ?? PUMP_STAGGER_MS_PER_INDEX;
    this.isMotorBusy = options.isMotorBusy;
  }

  /**
   * Submit a dose request to the FIFO queue. Returns a job id immediately.
   * Only one dose executes at a time.
   */
  async submitDose(
    pumpId: PumpId,
    amountMl: number,
    source: DoseSource,
    scheduleId: string | null = null,
    missedDoseId: string | null = null,
  ): Promise<string> {
    if (this.processing || this.queue.length > 0) {
      console.log(
        `[engine] queued ${pumpId} — ${this.current?.pumpId ?? 'another dose'} running (queue depth ${this.getQueueDepth()})`,
      );
    }
    const id = randomUUID();
    this.queue.push({ id, pumpId, amountMl, source, scheduleId, missedDoseId });
    void this.processQueue();
    return id;
  }

  getQueueDepth(): number {
    return this.queue.length + (this.active || this.current ? 1 : 0);
  }

  /**
   * Remove a not-yet-started queued dose by its missed-dose link (the engine
   * job ids are random UUIDs the missed-dose flow never sees). Only items
   * still in the FIFO queue are removed — an active (gap-waiting) or current
   * (executing) item is NOT, so a cancel mid-fire is rejected by the caller
   * instead of silently dropping a dose that already started.
   */
  cancelQueuedByMissedDoseId(missedDoseId: string): boolean {
    const index = this.queue.findIndex(
      (item) => item.missedDoseId === missedDoseId,
    );
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /** True when the dose for this missed-dose entry is active or executing. */
  hasMissedDoseInProgress(missedDoseId: string): boolean {
    return (
      this.active?.missedDoseId === missedDoseId ||
      this.current?.missedDoseId === missedDoseId
    );
  }

  getStatus(): EngineStatus {
    return {
      current: this.current,
      queueDepth: this.getQueueDepth(),
    };
  }

  /**
   * Snapshot of every queued item (and the gap-waiting "active" item, which
   * has been shifted off the queue but not started) with estimated fire
   * times. Estimates are computed from the minimum inter-dose gap and assume
   * instant dose durations — good enough for a "~HH:MM" UI label.
   *
   * Why `active` must be included: `active` is set when an item is shifted
   * and cleared only after `execute` finishes. If the current dose completed
   * instantly (fast pumps, mocked runs) the next item sits in `active`
   * sleeping out its gap — mapping only `this.queue` would hide it.
   */
  getQueueSnapshot(): EngineQueueSnapshotItem[] {
    const now = Date.now();
    let nextFireMs: number;
    const items: QueueItem[] = [];

    if (this.current !== null) {
      // A dose is executing; its end time is unknown, so the next item can
      // only start after the inter-dose gap from "now" at the earliest.
      nextFireMs = now + this.minInterDoseGapMs;
    } else if (this.active !== null) {
      // Gap-waiting: it fires when its gap sleep elapses.
      items.push(this.active);
      nextFireMs =
        this.lastRunEndAt !== null
          ? Math.max(now, this.lastRunEndAt + this.minInterDoseGapMs)
          : now;
    } else {
      nextFireMs = now;
    }

    items.push(...this.queue);
    return items.map((item) => {
      const estimatedFireAt = new Date(nextFireMs).toISOString();
      nextFireMs += this.minInterDoseGapMs;
      return {
        pumpId: item.pumpId,
        amountMl: item.amountMl,
        source: item.source,
        scheduleId: item.scheduleId,
        missedDoseId: item.missedDoseId,
        estimatedFireAt,
      };
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active = item;

      // Minimum inter-pump gap: the previous run's drivers must rest before
      // the next pump energises, whatever the trigger source.
      if (this.lastRunEndAt !== null && this.minInterDoseGapMs > 0) {
        const waitMs = this.minInterDoseGapMs - (Date.now() - this.lastRunEndAt);
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
      }

      await this.execute(item);
      this.lastRunEndAt = Date.now();
      this.active = null;
    }

    this.processing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async execute(item: QueueItem): Promise<void> {
    const event: DoseEvent = {
      // Reuse the queue item id so the jobId returned by POST /api/dose
      // matches the event id later surfaced in /api/status.
      id: item.id,
      pumpId: item.pumpId,
      requestedMl: item.amountMl,
      actualMl: null,
      status: 'running',
      source: item.source,
      scheduleId: item.scheduleId,
      missedDoseId: item.missedDoseId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.current = event;

    // Persist the running event immediately so a scheduler reboot can see it
    // and never double-fire a scheduled dose.
    try {
      await this.repository.saveDoseEvent(event);
    } catch (saveError) {
      console.error('Failed to save running dose event:', saveError);
    }

    try {
      // Global motor lock: prime/calibration own the motor outside this
      // queue. Wait them out rather than running two pumps at once.
      while (this.isMotorBusy?.()) {
        await this.sleep(500);
      }

      // Catch-up cancellation race: the user may have withdrawn this catch-up
      // in the window between it leaving the queue and the motor starting.
      // The entry must win: a withdrawn catch-up never fires. Recorded as a
      // deliberate 'skipped' (not a failure); finalizeDoseEvent only closes
      // entries still 'confirmed', so a 'cancelled' entry is never touched.
      if (
        item.source === 'catchup' &&
        item.missedDoseId !== null &&
        this.repository.getMissedDoseStatus
      ) {
        const status = await this.repository.getMissedDoseStatus(
          item.missedDoseId,
        );
        if (status !== 'confirmed') {
          throw new CancelledBeforeFireError();
        }
      }

      const systemVolumeLitres =
        await this.repository.getSystemVolumeLitres();
      const limits = computeDoseLimits(systemVolumeLitres);

      if (item.amountMl > limits.maxSingleDoseMl) {
        throw new Error(
          `Single dose ${item.amountMl}mL exceeds limit ${limits.maxSingleDoseMl.toFixed(2)}mL`,
        );
      }

      const todayMl = await this.repository.getTodayDoseMl(item.pumpId);
      if (todayMl + item.amountMl > limits.maxDailyDoseMlPerPump) {
        throw new Error(
          `Daily total for ${item.pumpId} would exceed ${limits.maxDailyDoseMlPerPump.toFixed(2)}mL`,
        );
      }

      const calibration = await this.repository.getPumpCalibration(
        item.pumpId,
      );
      if (calibration.stepsPerMl === null) {
        throw new Error(`Pump ${item.pumpId} is not calibrated`);
      }

      const steps = Math.round(item.amountMl * calibration.stepsPerMl);
      await runSteps(item.pumpId, steps);

      event.actualMl = item.amountMl;
      event.status = 'completed';

      try {
        await this.repository.decrementContainer(item.pumpId, item.amountMl);
      } catch (containerError) {
        console.error('Failed to decrement container:', containerError);
      }
    } catch (error) {
      if (error instanceof CancelledBeforeFireError) {
        event.status = 'skipped';
        event.error = 'Catch-up cancelled by user before it fired';
      } else {
        event.status = 'failed';
        event.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      // ------------------------------------------------------------------
      // Safety invariant: every execution path ends with drivers disabled.
      // ------------------------------------------------------------------
      event.finishedAt = new Date().toISOString();
      this.current = null;
      driversDisable();
      try {
        // finalizeDoseEvent closes the linked missed-dose entry in the same
        // transaction as this write, so a catch-up can never be eligible to
        // re-fire after its dose physically completed.
        const finalize = this.repository.finalizeDoseEvent;
        if (finalize) {
          await finalize.call(this.repository, event);
        } else {
          await this.repository.saveDoseEvent(event);
        }
      } catch (saveError) {
        // Persistence failure must not stop the queue or mask the fact that
        // the hardware has already been shut down.
        console.error('Failed to save dose event:', saveError);
      }
    }
  }
}

export function createEngine(
  repository: DoseRepository,
  options: EngineOptions = {},
): Engine {
  return new Engine(repository, options);
}
