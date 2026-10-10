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
    // The engine never touches container levels: the deduction is the
    // repository's finalizeDoseEvent job, in the dose event's transaction.
    expect(repo.finalizeDoseEvent).toBeUndefined();
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

  it('removes a queued (not started) catch-up by missed-dose id', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    let resolveFirst: (() => void) | null = null;
    vi.mocked(runSteps).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          // Only the FIRST run is held; later doses resolve immediately.
          if (resolveFirst === null) resolveFirst = resolve;
          else resolve();
        }),
    );

    const first = engine.submitDose('alk', 1, 'manual');
    await engine.submitDose('ca', 1, 'catchup', 'sched-1', 'missed-1');
    // Wait until the first dose is actually inside runSteps.
    await vi.waitFor(() => {
      if (resolveFirst === null) throw new Error('first dose not started');
    });

    expect(engine.cancelQueuedByMissedDoseId('missed-1')).toBe(true);
    expect(engine.getQueueDepth()).toBe(1); // only the running dose remains

    resolveFirst!();
    await first;
    await waitForQueueDrain(engine);

    // The cancelled catch-up never touched the hardware.
    expect(vi.mocked(runSteps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSteps).mock.calls[0]![0]).toBe('alk');
  });

  it('refuses to remove a catch-up that is gap-waiting or executing', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 200 });

    let resolveFirst: (() => void) | null = null;
    vi.mocked(runSteps).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          // Only the FIRST run is held; later doses resolve immediately.
          if (resolveFirst === null) resolveFirst = resolve;
          else resolve();
        }),
    );

    const first = engine.submitDose('alk', 1, 'manual');
    await engine.submitDose('ca', 1, 'catchup', 'sched-1', 'missed-1');
    await vi.waitFor(() => {
      if (resolveFirst === null) throw new Error('first dose not started');
    });
    resolveFirst!();
    await first;
    // Give processQueue a beat to shift the catch-up into its gap wait.
    await new Promise((r) => setTimeout(r, 50));

    // Dose 1 finished; the catch-up is now gap-waiting (active, not queued).
    expect(engine.hasMissedDoseInProgress('missed-1')).toBe(true);
    expect(engine.cancelQueuedByMissedDoseId('missed-1')).toBe(false);
    expect(engine.getQueueDepth()).toBe(1);
    // It still fires normally after the gap.
    await waitForQueueDrain(engine);
    expect(vi.mocked(runSteps).mock.calls.some((c) => c[0] === 'ca')).toBe(true);
  });

  it('never fires a catch-up whose entry was cancelled after queueing (race guard)', async () => {
    // getMissedDoseStatus flips to 'cancelled' while the dose waits in the
    // queue — the engine must see it at fire time and skip the hardware run.
    const repo = createMockRepository({
      getMissedDoseStatus: vi.fn().mockResolvedValue('cancelled'),
    });
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('ca', 1, 'catchup', 'sched-1', 'missed-1');
    await waitForQueueDrain(engine);

    expect(runSteps).not.toHaveBeenCalled();
    const calls = vi.mocked(repo.saveDoseEvent).mock.calls;
    const finalEvent = calls[calls.length - 1]![0];
    expect(finalEvent.status).toBe('skipped');
    expect(finalEvent.error).toMatch(/cancelled/i);
    expect(finalEvent.missedDoseId).toBe('missed-1');
  });

  it('fires a catch-up whose entry is still confirmed', async () => {
    const repo = createMockRepository({
      getMissedDoseStatus: vi.fn().mockResolvedValue('confirmed'),
    });
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    await engine.submitDose('ca', 1, 'catchup', 'sched-1', 'missed-1');
    await waitForQueueDrain(engine);

    expect(runSteps).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(repo.saveDoseEvent).mock.calls;
    const finalEvent = calls[calls.length - 1]![0];
    expect(finalEvent.status).toBe('completed');
  });

  it('removes a queued (not started) manual dose by job id', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    let resolveFirst: (() => void) | null = null;
    vi.mocked(runSteps).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          // Only the FIRST run is held; later doses resolve immediately.
          if (resolveFirst === null) resolveFirst = resolve;
          else resolve();
        }),
    );

    const first = engine.submitDose('alk', 1, 'manual');
    const secondJobId = await engine.submitDose('ca', 2, 'manual');
    // Wait until the first dose is actually inside runSteps.
    await vi.waitFor(() => {
      if (resolveFirst === null) throw new Error('first dose not started');
    });
    expect(engine.getQueueDepth()).toBe(2);

    const withdrawn = engine.cancelQueuedById(secondJobId);
    expect(withdrawn).toEqual({
      id: secondJobId,
      pumpId: 'ca',
      amountMl: 2,
      source: 'manual',
    });
    expect(engine.getQueueDepth()).toBe(1); // only the running dose remains

    resolveFirst!();
    await first;
    await waitForQueueDrain(engine);

    // The cancelled dose never touched the hardware.
    expect(vi.mocked(runSteps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSteps).mock.calls[0]![0]).toBe('alk');

    // The FIFO splice means execute() never saw the job, so the owner-cancel
    // backstop never fired either: no saved event of ANY kind carries the
    // cancelled job id.
    const eventsForCancelledJob = vi
      .mocked(repo.saveDoseEvent)
      .mock.calls.map((c) => c[0] as DoseEvent)
      .filter((e) => e.id === secondJobId);
    expect(eventsForCancelledJob).toEqual([]);
  });

  it('refuses to cancel a manual dose that is executing or gap-waiting', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 200 });

    let resolveFirst: (() => void) | null = null;
    vi.mocked(runSteps).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          // Only the FIRST run is held; later doses resolve immediately.
          if (resolveFirst === null) resolveFirst = resolve;
          else resolve();
        }),
    );

    const first = engine.submitDose('alk', 1, 'manual');
    const firstJobId = await first;
    const secondJobId = await engine.submitDose('ca', 1, 'manual');
    await vi.waitFor(() => {
      if (resolveFirst === null) throw new Error('first dose not started');
    });

    // Currently executing: not withdrawable.
    expect(engine.isExecuting(firstJobId)).toBe(true);
    expect(engine.cancelQueuedById(firstJobId)).toBeNull();

    resolveFirst!();
    await first;
    // Give processQueue a beat to shift the second dose into its gap wait.
    await new Promise((r) => setTimeout(r, 50));

    // Gap-waiting (active, not queued): still not withdrawable, and the dose
    // fires normally once the gap elapses.
    expect(engine.isExecuting(secondJobId)).toBe(true);
    expect(engine.cancelQueuedById(secondJobId)).toBeNull();
    expect(engine.getQueueDepth()).toBe(1);
    await waitForQueueDrain(engine);
    expect(vi.mocked(runSteps).mock.calls.some((c) => c[0] === 'ca')).toBe(true);
  });

  it('getQueueSnapshot items carry the stable job id from submitDose', async () => {
    const repo = createMockRepository();
    const engine = createEngine(repo, { minInterDoseGapMs: 0 });

    // Hang every run so the queue state stays observable.
    vi.mocked(runSteps).mockImplementation(() => new Promise(() => {}));

    const firstJobId = await engine.submitDose('alk', 1, 'manual');
    const secondJobId = await engine.submitDose('ca', 2, 'manual');
    await vi.waitFor(() => {
      if (engine.getStatus().current?.id !== firstJobId) {
        throw new Error('first dose not running');
      }
    });

    const snapshot = engine.getQueueSnapshot();
    const queued = snapshot.find((item) => item.id === secondJobId);
    expect(queued).toMatchObject({
      id: secondJobId,
      pumpId: 'ca',
      amountMl: 2,
      source: 'manual',
    });
    expect(typeof queued?.estimatedFireAt).toBe('string');
    // The executing dose is not part of the queue snapshot.
    expect(snapshot.some((item) => item.id === firstJobId)).toBe(false);
  });
});
