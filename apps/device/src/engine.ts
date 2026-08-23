import { randomUUID } from 'node:crypto';
import { computeDoseLimits } from '@reef/shared';
import type { DoseEvent, PumpId } from '@reef/shared';
import { driversDisable } from './gpio.js';
import { runSteps } from './stepper.js';

export type DoseSource = 'manual' | 'schedule' | 'calibration';

export interface PumpCalibration {
  pumpId: PumpId;
  stepsPerMl: number | null;
}

/**
 * Interface the persistence layer must satisfy. The engine does not care
 * whether this is SQLite, a JSON file, or an in-memory store for tests.
 */
export interface DoseRepository {
  getSystemVolumeLitres(): Promise<number>;
  getTodayDoseMl(pumpId: PumpId): Promise<number>;
  getPumpCalibration(pumpId: PumpId): Promise<PumpCalibration>;
  saveDoseEvent(event: DoseEvent): Promise<void>;
}

interface QueueItem {
  id: string;
  pumpId: PumpId;
  amountMl: number;
  source: DoseSource;
}

export interface EngineStatus {
  current: DoseEvent | null;
  queueDepth: number;
}

class Engine {
  private queue: QueueItem[] = [];
  private processing = false;
  private current: DoseEvent | null = null;

  constructor(private repository: DoseRepository) {}

  /**
   * Submit a dose request to the FIFO queue. Returns a job id immediately.
   * Only one dose executes at a time.
   */
  async submitDose(
    pumpId: PumpId,
    amountMl: number,
    source: DoseSource,
  ): Promise<string> {
    const id = randomUUID();
    this.queue.push({ id, pumpId, amountMl, source });
    void this.processQueue();
    return id;
  }

  getQueueDepth(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  getStatus(): EngineStatus {
    return {
      current: this.current,
      queueDepth: this.getQueueDepth(),
    };
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.execute(item);
    }

    this.processing = false;
  }

  private async execute(item: QueueItem): Promise<void> {
    const event: DoseEvent = {
      id: randomUUID(),
      pumpId: item.pumpId,
      requestedMl: item.amountMl,
      actualMl: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.current = event;

    try {
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
    } catch (error) {
      event.status = 'failed';
      event.error = error instanceof Error ? error.message : String(error);
    } finally {
      // ------------------------------------------------------------------
      // Safety invariant: every execution path ends with drivers disabled.
      // ------------------------------------------------------------------
      event.finishedAt = new Date().toISOString();
      this.current = null;
      driversDisable();
      try {
        await this.repository.saveDoseEvent(event);
      } catch (saveError) {
        // Persistence failure must not stop the queue or mask the fact that
        // the hardware has already been shut down.
        console.error('Failed to save dose event:', saveError);
      }
    }
  }
}

export function createEngine(repository: DoseRepository): Engine {
  return new Engine(repository);
}
