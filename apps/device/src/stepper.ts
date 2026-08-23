import {
  WAVE_MODE_ONE_SHOT,
  waveAddGeneric,
  waveClear,
  waveCreate,
  waveDelete,
  waveTxBusy,
  waveTxSend,
} from 'pigpio';
import { LIMITS } from '@reef/shared';
import type { PumpId } from '@reef/shared';
import { GPIO_PINS, driversDisable, driversEnable } from './gpio.js';

// Number of steps per pigpio wave. Each step is 2 pulses (rise + fall),
// so 1000 steps == 2000 pulses. This keeps waves well under pigpio's DMA
// buffer and lets us dose arbitrarily long runs by chaining waves.
export const MAX_STEPS_PER_WAVE = 1000;
const DRIVER_SETTLE_MS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function halfPeriodUs(): number {
  // period = 1 / Hz; half-period = period / 2, rounded to integer µs.
  return Math.round(1_000_000 / LIMITS.stepRateHz / 2);
}

function buildStepPulses(
  stepGpio: number,
  steps: number,
): { gpioOn: number; gpioOff: number; usDelay: number }[] {
  const delay = halfPeriodUs();
  const pulses: { gpioOn: number; gpioOff: number; usDelay: number }[] = [];

  for (let i = 0; i < steps; i++) {
    pulses.push({ gpioOn: stepGpio, gpioOff: 0, usDelay: delay });
    pulses.push({ gpioOn: 0, gpioOff: stepGpio, usDelay: delay });
  }

  return pulses;
}

async function sendWave(steps: number, stepGpio: number): Promise<void> {
  const pulses = buildStepPulses(stepGpio, steps);

  waveClear();
  waveAddGeneric(pulses);
  const waveId = waveCreate();

  if (waveId < 0) {
    throw new Error(`Failed to create pigpio wave (${steps} steps)`);
  }

  try {
    waveTxSend(waveId, WAVE_MODE_ONE_SHOT);
    while (waveTxBusy()) {
      await sleep(1);
    }
  } finally {
    waveDelete(waveId);
  }
}

/**
 * Low-level helper: send a single chunk of STEP pulses for one pump.
 * Does NOT enable/disable drivers — the caller owns that.
 */
export async function runWaveChunk(
  pump: PumpId,
  steps: number,
): Promise<void> {
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new Error(`steps must be a positive integer (got ${steps})`);
  }
  if (steps > MAX_STEPS_PER_WAVE) {
    throw new Error(
      `chunk exceeds MAX_STEPS_PER_WAVE (${MAX_STEPS_PER_WAVE})`,
    );
  }
  const stepGpio = GPIO_PINS.step[pump];
  await sendWave(steps, stepGpio);
}

/**
 * Run a fixed number of STEP pulses for one pump.
 *
 * Sequence:
 *   1. Enable the selected driver's EN pin.
 *   2. Wait 5 ms for the stepstick to settle.
 *   3. Send the STEP waveform (split into multiple waves if necessary).
 *   4. Wait until the wave has finished transmitting.
 *   5. Disable all drivers in a finally block.
 */
export async function runSteps(pump: PumpId, steps: number): Promise<void> {
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new Error(`steps must be a positive integer (got ${steps})`);
  }

  const stepGpio = GPIO_PINS.step[pump];
  let remaining = steps;

  driversEnable(pump);
  await sleep(DRIVER_SETTLE_MS);

  try {
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_STEPS_PER_WAVE);
      await sendWave(chunk, stepGpio);
      remaining -= chunk;
    }
  } finally {
    driversDisable();
  }
}
