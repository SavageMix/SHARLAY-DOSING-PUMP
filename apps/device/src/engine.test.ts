import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDoseLimits } from '@reef/shared';
import type { DoseEvent, PumpId } from '@reef/shared';
import { createEngine, type DoseRepository } from '../src/engine.js';

vi.mock('../src/gpio.js', () => ({
  driversDisable: vi.fn(),
  driversEnable: vi.fn(),
  GPIO_PINS: {},
  stepPins: {},
  dirPin: {},
  configurePins: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('../src/stepper.js', () => ({
  runSteps: vi.fn(),
}));

import { driversDisable } from '../src/gpio.js';
import { runSteps } from '../src/stepper.js';

const SYSTEM_VOLUME_L = 380;
const STEPS_PER_ML = 100;

function createMockRepository(
  overrides: Partial<DoseRepository> = {},
): DoseRepository {
  return {
    getSystemVolumeLitres: vi.fn().mockResolvedValue(SYSTEM_VOLUME_L),
    getTodayDoseMl: vi.fn().mockResolvedValue(0),
    getPumpCalibration: vi.fn().mockImplementation((pumpId: PumpId) =>
      Promise.resolve({ pumpId, stepsPerMl: STEPS_PER_ML }),
    ),
    saveDoseEvent: vi.fn().mockResolvedValue(undefined),
    decrementContainer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function waitForQueueDrain(engine: { getQueueDepth: () => number }) {
  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (engine.getQueueDepth() === 0) {
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

function getSavedEvent(repo: DoseRepository): DoseEvent {
  const calls = vi.mocked(repo.saveDoseEvent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0][0] as DoseEvent;
}

describe('DoseEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes queued doses in FIFO order', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });
    const order: PumpId[] = [];

    vi.mocked(runSteps).mockImplementation(async (pump) => {
      order.push(pump);
    });

    await engine.submitDose('alk', 1, 'manual');
    await engine.submitDose('ca', 1, 'manual');
    await engine.submitDose('no3', 1, 'manual');
    await waitForQueueDrain(engine);

    expect(order).toEqual(['alk', 'ca', 'no3']);
    expect(repo.saveDoseEvent).toHaveBeenCalledTimes(6); // running + final per dose
    expect(repo.decrementContainer).toHaveBeenCalledTimes(3);
  });

  it('rejects doses exceeding the single-dose limit', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });
    const limits = computeDoseLimits(SYSTEM_VOLUME_L);

    await engine.submitDose('alk', limits.maxSingleDoseMl + 1, 'manual');
    await waitForQueueDrain(engine);

    const event = getSavedEvent(repo);
    expect(event.status).toBe('failed');
    expect(event.error).toMatch(/exceeds limit/i);
    expect(runSteps).not.toHaveBeenCalled();
    expect(driversDisable).toHaveBeenCalled();
  });

  it('rejects doses that would exceed the daily total', async () => {
    const limits = computeDoseLimits(SYSTEM_VOLUME_L);
    const repo = createMockRepository({
      getTodayDoseMl: vi.fn().mockResolvedValue(limits.maxDailyDoseMlPerPump - 1),
    });
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('alk', 2, 'manual'); // 1 + 2 > daily limit
    await waitForQueueDrain(engine);

    const event = getSavedEvent(repo);
    expect(event.status).toBe('failed');
    expect(event.error).toMatch(/daily total/i);
    expect(runSteps).not.toHaveBeenCalled();
    expect(driversDisable).toHaveBeenCalled();
  });

  it('rejects uncalibrated pumps', async () => {
    const repo = createMockRepository({
      getPumpCalibration: vi.fn().mockResolvedValue({
        pumpId: 'alk' as PumpId,
        stepsPerMl: null,
      }),
    });
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('alk', 1, 'manual');
    await waitForQueueDrain(engine);

    const event = getSavedEvent(repo);
    expect(event.status).toBe('failed');
    expect(event.error).toMatch(/not calibrated/i);
    expect(runSteps).not.toHaveBeenCalled();
    expect(driversDisable).toHaveBeenCalled();
  });

  it('disables drivers and records failure when runSteps throws mid-dose', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    vi.mocked(runSteps).mockRejectedValue(new Error('stepper fault'));

    await engine.submitDose('alk', 1, 'manual');
    await waitForQueueDrain(engine);

    expect(runSteps).toHaveBeenCalledOnce();
    expect(driversDisable).toHaveBeenCalled();

    const event = getSavedEvent(repo);
    expect(event.status).toBe('failed');
    expect(event.error).toMatch(/stepper fault/i);
    expect(event.actualMl).toBeNull();
  });

  it('only runs one dose at a time', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });
    let concurrent = 0;
    let maxConcurrent = 0;

    vi.mocked(runSteps).mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent--;
    });

    await engine.submitDose('alk', 1, 'manual');
    await engine.submitDose('ca', 1, 'manual');
    await engine.submitDose('no3', 1, 'manual');
    await waitForQueueDrain(engine);

    expect(maxConcurrent).toBe(1);
    expect(runSteps).toHaveBeenCalledTimes(3);
  });

  it('converts mL to steps using calibration and passes them to runSteps', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('alk', 2.5, 'manual');
    await waitForQueueDrain(engine);

    expect(runSteps).toHaveBeenCalledWith('alk', 250); // 2.5 mL * 100 steps/mL
    const event = getSavedEvent(repo);
    expect(event.status).toBe('completed');
    expect(event.actualMl).toBe(2.5);
    expect(event.source).toBe('manual');
    expect(event.scheduleId).toBeNull();
    expect(repo.decrementContainer).toHaveBeenCalledWith('alk', 2.5);
  });

  it('records scheduleId and source for scheduled doses', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('alk', 1, 'schedule', 'sched-1');
    await waitForQueueDrain(engine);

    const event = getSavedEvent(repo);
    expect(event.source).toBe('schedule');
    expect(event.scheduleId).toBe('sched-1');
  });

  it('links catch-up doses to their missed-dose entry', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('alk', 1, 'catchup', 'sched-1', 'missed-1');
    await waitForQueueDrain(engine);

    const event = getSavedEvent(repo);
    expect(event.source).toBe('catchup');
    expect(event.missedDoseId).toBe('missed-1');
  });

  it('uses finalizeDoseEvent when the repository provides it', async () => {
    const finalizeMock = vi.fn().mockResolvedValue(undefined);
    const repo = createMockRepository({ finalizeDoseEvent: finalizeMock });
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('alk', 1, 'catchup', 'sched-1', 'missed-1');
    await waitForQueueDrain(engine);

    // The running save still goes through saveDoseEvent; the FINAL save must
    // go through finalizeDoseEvent so the missed entry closes atomically
    // with the dose event.
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    const finalized = finalizeMock.mock.calls[0]![0];
    expect(finalized.status).toBe('completed');
    expect(finalized.missedDoseId).toBe('missed-1');
  });

  it('enforces the minimum inter-pump gap between queued doses', async () => {
    const repo = createMockRepository();
    const gapMs = 60;
    const engine = createEngine(repo, { minInterDoseGapMs: gapMs });

    const startTimes: number[] = [];
    const endTimes: number[] = [];
    vi.mocked(runSteps).mockImplementation(async () => {
      startTimes.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 10));
      endTimes.push(Date.now());
    });

    await engine.submitDose('alk', 1, 'manual');
    await engine.submitDose('ca', 1, 'manual');
    await waitForQueueDrain(engine);

    expect(startTimes).toHaveLength(2);
    // The second pump must not start until the gap after the first ended.
    expect(startTimes[1] - endTimes[0]).toBeGreaterThanOrEqual(gapMs);
  });

  it('waits out a busy motor (prime/calibration) before running steps', async () => {
    const repo = createMockRepository();
    let motorBusy = true;
    const engine = createEngine(repo, {
      minInterDoseGapMs: 0,
      isMotorBusy: () => motorBusy,
    });

    // The routine (prime/calibration) owns the motor for ~300 ms, then ends.
    const routineEnd = setTimeout(() => {
      motorBusy = false;
    }, 300);

    let runStepsCalls = 0;
    vi.mocked(runSteps).mockImplementation(async () => {
      runStepsCalls += 1;
    });

    await engine.submitDose('alk', 1, 'manual');
    await waitForQueueDrain(engine);
    clearTimeout(routineEnd);

    // Exactly one hardware run: the dose waited for the motor instead of
    // overlapping the routine, and was not retried afterwards.
    expect(runStepsCalls).toBe(1);
    expect(repo.saveDoseEvent).toHaveBeenCalledTimes(2); // running + final
    const finalEvent = vi.mocked(repo.saveDoseEvent).mock.calls[1]![0];
    expect(finalEvent.status).toBe('completed');
  });
});
