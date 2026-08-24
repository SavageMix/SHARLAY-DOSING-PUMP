import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessions,
  isCalibrating,
  startCalibration,
  stopCalibration,
} from '../src/calibrator.js';

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
  MAX_STEPS_PER_WAVE: 1000,
  runWaveChunk: vi.fn(),
}));

import { driversDisable, driversEnable } from '../src/gpio.js';
import { runWaveChunk } from '../src/stepper.js';

const CHUNK_DURATION_MS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Calibrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    let chunks = 0;
    vi.mocked(runWaveChunk).mockImplementation(async () => {
      chunks++;
      await sleep(CHUNK_DURATION_MS);
    });
    (runWaveChunk as any).__getChunks = () => chunks;
  });

  afterEach(async () => {
    for (const pumpId of ['alk', 'ca', 'no3', 'po4'] as const) {
      if (isCalibrating(pumpId)) {
        try {
          await stopCalibration(pumpId);
        } catch {
          // already stopped
        }
      }
    }
    __resetSessions();
  });

  it('loops continuously until stopCalibration() is called', async () => {
    startCalibration('alk');
    expect(isCalibrating('alk')).toBe(true);
    expect(driversEnable).toHaveBeenCalledWith('alk');

    await sleep(100);
    expect((runWaveChunk as any).__getChunks()).toBeGreaterThanOrEqual(2);

    const totalSteps = await stopCalibration('alk');
    expect(totalSteps).toBe((runWaveChunk as any).__getChunks() * 1000);
    expect(isCalibrating('alk')).toBe(false);
    expect(driversDisable).toHaveBeenCalled();
  });

  it('disables drivers in finally even when stop is called mid-chunk', async () => {
    startCalibration('ca');
    await sleep(CHUNK_DURATION_MS / 2);

    expect(driversEnable).toHaveBeenCalledWith('ca');
    expect((runWaveChunk as any).__getChunks()).toBe(1);

    const stopPromise = stopCalibration('ca');
    await sleep(CHUNK_DURATION_MS);

    const totalSteps = await stopPromise;
    expect(totalSteps).toBe(1000);
    expect(driversDisable).toHaveBeenCalled();
    expect(isCalibrating('ca')).toBe(false);
  });

  it('auto-stops via the watchdog step backstop and disables drivers', async () => {
    // 3500 steps => 3 full 1000-step chunks plus a 500-step final chunk.
    startCalibration('no3', { maxSteps: 3500 });

    // Wait for the watchdog to finish the session.
    const deadline = Date.now() + 1000;
    while (isCalibrating('no3') && Date.now() < deadline) {
      await sleep(CHUNK_DURATION_MS);
    }

    expect(isCalibrating('no3')).toBe(false);
    expect((runWaveChunk as any).__getChunks()).toBe(4);
    expect(driversDisable).toHaveBeenCalled();
  });

  it('uses the default 2-minute backstop when maxSteps is omitted', async () => {
    startCalibration('po4');
    await sleep(CHUNK_DURATION_MS * 3);

    expect(isCalibrating('po4')).toBe(true);
    expect((runWaveChunk as any).__getChunks()).toBeGreaterThanOrEqual(2);

    await stopCalibration('po4');
    expect(driversDisable).toHaveBeenCalled();
  });

  it('throws if a calibration is already running for the same pump', async () => {
    startCalibration('alk');
    await sleep(CHUNK_DURATION_MS / 2);

    expect(() => startCalibration('alk')).toThrow(
      /Calibration already running for alk/,
    );

    await stopCalibration('alk');
  });

  it('throws when stopping a pump that is not calibrating', async () => {
    await expect(stopCalibration('alk')).rejects.toThrow(
      /No calibration running for alk/,
    );
  });
});
