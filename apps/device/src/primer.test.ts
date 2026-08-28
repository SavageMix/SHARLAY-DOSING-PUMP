import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessions,
  isPriming,
  startPrime,
  stopPrime,
} from '../src/primer.js';

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
  runWaveChunk: vi.fn(),
  MAX_STEPS_PER_WAVE: 1000,
}));

import { driversDisable, driversEnable } from '../src/gpio.js';
import { runWaveChunk } from '../src/stepper.js';

const CHUNK_DURATION_MS = 5;
const STEP_RATE_HZ = 800;
const DEFAULT_PRIME_SECONDS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Primer', () => {
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
      if (isPriming(pumpId)) {
        try {
          await stopPrime(pumpId);
        } catch {
          // already stopped
        }
      }
    }
    __resetSessions();
  });

  it('runs until stop and returns the total steps', async () => {
    startPrime('alk');
    expect(isPriming('alk')).toBe(true);
    expect(driversEnable).toHaveBeenCalledWith('alk');

    await sleep(100);
    expect((runWaveChunk as any).__getChunks()).toBeGreaterThanOrEqual(2);

    const totalSteps = await stopPrime('alk');
    expect(totalSteps).toBe((runWaveChunk as any).__getChunks() * 1000);
    expect(isPriming('alk')).toBe(false);
    expect(driversDisable).toHaveBeenCalled();
  });

  it('refuses to start a second prime on the same pump', () => {
    startPrime('alk');
    expect(() => startPrime('alk')).toThrow(/already running/i);
  });

  it('stops automatically at the watchdog backstop', async () => {
    startPrime('alk');

    // Poll until the watchdog backstop finishes the session.
    // 96 chunks at 5 ms per chunk = ~480 ms, plus scheduling overhead.
    const deadline = Date.now() + 3000;
    while (isPriming('alk') && Date.now() < deadline) {
      await sleep(CHUNK_DURATION_MS);
    }

    expect(isPriming('alk')).toBe(false);
    expect(driversDisable).toHaveBeenCalled();
    expect((runWaveChunk as any).__getChunks()).toBe(
      (STEP_RATE_HZ * DEFAULT_PRIME_SECONDS) / 1000,
    );
  });

  it('throws when stopping a pump that is not priming', async () => {
    await expect(stopPrime('alk')).rejects.toThrow(/no prime running/i);
  });
});
