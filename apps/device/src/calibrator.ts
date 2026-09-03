import type { CalibrateStoppedBy, PumpId } from '@reef/shared';
import { LIMITS } from '@reef/shared';
import { driversDisable, driversEnable } from './gpio.js';
import { MAX_STEPS_PER_WAVE, runWaveChunk } from './stepper.js';

const CALIBRATION_CHUNK_STEPS = MAX_STEPS_PER_WAVE;
const CHUNK_INTERVAL_MS = 0;

/**
 * Watchdog backstop: 9 minutes of runtime at the configured step rate.
 *
 * Sized for a maximum 30 mL run: 30 mL × ~14k steps/mL ≈ 421k steps ≈ 527 s
 * at 800 Hz, rounded up to 540 s (432,000 steps ≈ 30.7 mL). Covers full
 * 30 mL calibration runs with a small margin, while still capping runaway
 * sessions (stuck client, forgotten stop, etc.).
 *
 * The caller can pass a lower maxSteps in startCalibration(); this is only
 * used when no explicit backstop is supplied.
 */
export const WATCHDOG_TIMEOUT_S = 540;

interface CalibrationSession {
  pumpId: PumpId;
  stop: boolean;
  totalSteps: number;
  maxSteps: number;
  stoppedBy: CalibrateStoppedBy;
  promise: Promise<void>;
}

const sessions = new Map<PumpId, CalibrationSession>();

/**
 * Outcome of a completed calibration run. Kept after the session is removed
 * so the app can fold the run into its save step even when the watchdog
 * ended it and no stop was requested.
 */
export interface CalibrationCompletion {
  pumpId: PumpId;
  totalSteps: number;
  stoppedBy: CalibrateStoppedBy;
}

/**
 * Most recent completed run, kept after the session is removed so the app
 * can learn about a watchdog stop even if it never called stopCalibration().
 */
let lastResult: CalibrationCompletion | null = null;

export function getLastCalibrationResult(): CalibrationCompletion | null {
  return lastResult;
}

function defaultMaxSteps(): number {
  return LIMITS.stepRateHz * WATCHDOG_TIMEOUT_S;
}

function removeSession(pumpId: PumpId): void {
  sessions.delete(pumpId);
}

async function runCalibrationLoop(session: CalibrationSession): Promise<void> {
  driversEnable(session.pumpId);

  try {
    while (!session.stop && session.totalSteps < session.maxSteps) {
      const remaining = session.maxSteps - session.totalSteps;
      const chunkSteps = Math.min(CALIBRATION_CHUNK_STEPS, remaining);

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
    // visible in the service log instead of looking like a glitch. A
    // watchdog stop is not a failure — the dispensed volume is still
    // measurable, so the run can continue to the save step.
    if (!session.stop && session.totalSteps >= session.maxSteps) {
      session.stoppedBy = 'watchdog';
      const backstopS = Math.round(session.maxSteps / LIMITS.stepRateHz);
      console.warn(
        `[calibrator] WATCHDOG fired after ${backstopS}s — auto-stopping ${session.pumpId}`,
      );
    }
  } finally {
    // Watchdog expiry, clean stop, or error: always remove the session and
    // disable the drivers.
    session.stop = true;
    lastResult = {
      pumpId: session.pumpId,
      totalSteps: session.totalSteps,
      stoppedBy: session.stoppedBy,
    };
    removeSession(session.pumpId);
    driversDisable();
  }
}

/**
 * Start running a pump continuously for calibration.
 *
 * The pump runs in MAX_STEPS_PER_WAVE chunks until either:
 *   - stopCalibration() is called, or
 *   - the step backstop is reached (default: 9-minute watchdog).
 *
 * Safety invariant: drivers are enabled when the loop starts and disabled in a
 * finally block on every exit path, including errors and watchdog expiry.
 */
export function startCalibration(
  pumpId: PumpId,
  options: { maxSteps?: number } = {},
): void {
  if (sessions.has(pumpId)) {
    throw new Error(`Calibration already running for ${pumpId}`);
  }

  const maxSteps =
    options.maxSteps !== undefined && options.maxSteps > 0
      ? options.maxSteps
      : defaultMaxSteps();

  const session: CalibrationSession = {
    pumpId,
    stop: false,
    totalSteps: 0,
    maxSteps,
    stoppedBy: 'user',
    promise: Promise.resolve(),
  };

  session.promise = runCalibrationLoop(session).catch((error) => {
    console.error(`Calibration error for ${pumpId}:`, error);
    throw error;
  });

  sessions.set(pumpId, session);
}

/**
 * Stop the calibration loop for a pump and return the run outcome.
 * Safe to call multiple times; subsequent calls return the final outcome.
 */
export async function stopCalibration(pumpId: PumpId): Promise<CalibrationCompletion> {
  const session = sessions.get(pumpId);
  if (!session) {
    throw new Error(`No calibration running for ${pumpId}`);
  }

  session.stop = true;
  await session.promise.catch(() => {});

  // The loop's finally block may have already removed the session.
  sessions.delete(pumpId);

  return {
    pumpId: session.pumpId,
    totalSteps: session.totalSteps,
    stoppedBy: session.stoppedBy,
  };
}

export function isCalibrating(pumpId: PumpId): boolean {
  return sessions.has(pumpId);
}

/**
 * Test-only helper: clear all sessions and the last result without touching
 * drivers. Do not use in production code.
 */
export function __resetSessions(): void {
  sessions.clear();
  lastResult = null;
}
