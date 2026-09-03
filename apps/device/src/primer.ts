import type { PumpId } from '@reef/shared';
import { LIMITS } from '@reef/shared';
import { driversDisable, driversEnable } from './gpio.js';
import { MAX_STEPS_PER_WAVE, runWaveChunk } from './stepper.js';

const PRIME_CHUNK_STEPS = MAX_STEPS_PER_WAVE;
const CHUNK_INTERVAL_MS = 0;

/**
 * Watchdog backstop: 15 minutes of runtime at the configured step rate.
 *
 * 15 min = 720,000 steps at 800 Hz ≈ 51 mL at ~14k steps/mL. Priming rarely
 * needs more than a few mL, so this is far beyond any sane prime run, while
 * still capping runaway sessions (stuck client, forgotten stop, etc.).
 */
export const WATCHDOG_TIMEOUT_S = 900;

interface PrimeSession {
  pumpId: PumpId;
  stop: boolean;
  totalSteps: number;
  maxSteps: number;
  promise: Promise<void>;
}

const sessions = new Map<PumpId, PrimeSession>();

function defaultMaxSteps(): number {
  return LIMITS.stepRateHz * WATCHDOG_TIMEOUT_S;
}

function removeSession(pumpId: PumpId): void {
  sessions.delete(pumpId);
}

async function runPrimeLoop(session: PrimeSession): Promise<void> {
  driversEnable(session.pumpId);

  try {
    while (!session.stop && session.totalSteps < session.maxSteps) {
      const remaining = session.maxSteps - session.totalSteps;
      const chunkSteps = Math.min(PRIME_CHUNK_STEPS, remaining);

      await runWaveChunk(session.pumpId, chunkSteps);
      session.totalSteps += chunkSteps;

      // The stop flag is checked here, between wave chunks. pigpio waves run to
      // completion once transmitted, so a stop request is honored at the next
      // chunk boundary. The drivers are always disabled in the finally block.
      if (CHUNK_INTERVAL_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS));
      }
    }

    // Log watchdog expiry distinctly from a clean stop so a backstop stop is
    // visible in the service log instead of looking like a glitch.
    if (!session.stop && session.totalSteps >= session.maxSteps) {
      const backstopS = Math.round(session.maxSteps / LIMITS.stepRateHz);
      console.warn(
        `[primer] WATCHDOG fired after ${backstopS}s — auto-stopping ${session.pumpId}`,
      );
    }
  } finally {
    // Watchdog expiry, clean stop, or error: always remove the session and
    // disable the drivers.
    session.stop = true;
    removeSession(session.pumpId);
    driversDisable();
  }
}

/**
 * Start running a pump continuously for priming.
 *
 * The pump runs in MAX_STEPS_PER_WAVE chunks until either:
 *   - stopPrime() is called, or
 *   - the 15-minute step backstop is reached.
 *
 * Safety invariant: drivers are enabled when the loop starts and disabled in a
 * finally block on every exit path, including errors and watchdog expiry.
 */
export function startPrime(pumpId: PumpId): void {
  if (sessions.has(pumpId)) {
    throw new Error(`Prime already running for ${pumpId}`);
  }

  const session: PrimeSession = {
    pumpId,
    stop: false,
    totalSteps: 0,
    maxSteps: defaultMaxSteps(),
    promise: Promise.resolve(),
  };

  session.promise = runPrimeLoop(session).catch((error) => {
    console.error(`Prime error for ${pumpId}:`, error);
    throw error;
  });

  sessions.set(pumpId, session);
}

/**
 * Stop the prime loop for a pump and return the total steps run.
 * Safe to call multiple times; subsequent calls return the final step count.
 */
export async function stopPrime(pumpId: PumpId): Promise<number> {
  const session = sessions.get(pumpId);
  if (!session) {
    throw new Error(`No prime running for ${pumpId}`);
  }

  session.stop = true;
  await session.promise.catch(() => {});

  // The loop's finally block may have already removed the session.
  sessions.delete(pumpId);

  return session.totalSteps;
}

export function isPriming(pumpId?: PumpId): boolean {
  if (pumpId) {
    return sessions.has(pumpId);
  }
  return sessions.size > 0;
}

/**
 * Test-only helper: clear all sessions without touching drivers.
 * Do not use in production code.
 */
export function __resetSessions(): void {
  sessions.clear();
}
