import type { PumpId } from '@reef/shared';
import { driversDisable, driversEnable } from './gpio.js';
import { MAX_STEPS_PER_WAVE, runWaveChunk } from './stepper.js';

const CALIBRATION_CHUNK_STEPS = MAX_STEPS_PER_WAVE;
const CHUNK_INTERVAL_MS = 0;

interface CalibrationSession {
  pumpId: PumpId;
  stop: boolean;
  totalSteps: number;
  promise: Promise<void>;
}

const sessions = new Map<PumpId, CalibrationSession>();

async function runCalibrationLoop(session: CalibrationSession): Promise<void> {
  driversEnable(session.pumpId);

  try {
    while (!session.stop) {
      await runWaveChunk(session.pumpId, CALIBRATION_CHUNK_STEPS);
      session.totalSteps += CALIBRATION_CHUNK_STEPS;
      if (CHUNK_INTERVAL_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS));
      }
    }
  } finally {
    driversDisable();
  }
}

/**
 * Start running a pump continuously for calibration.
 * The pump runs in chunks until stopCalibration() is called.
 */
export function startCalibration(pumpId: PumpId): void {
  if (sessions.has(pumpId)) {
    throw new Error(`Calibration already running for ${pumpId}`);
  }

  const session: CalibrationSession = {
    pumpId,
    stop: false,
    totalSteps: 0,
    promise: Promise.resolve(),
  };

  session.promise = runCalibrationLoop(session).catch((error) => {
    console.error(`Calibration error for ${pumpId}:`, error);
    throw error;
  });

  sessions.set(pumpId, session);
}

/**
 * Stop the calibration loop for a pump and return the total steps dispensed.
 */
export async function stopCalibration(pumpId: PumpId): Promise<number> {
  const session = sessions.get(pumpId);
  if (!session) {
    throw new Error(`No calibration running for ${pumpId}`);
  }

  session.stop = true;
  await session.promise.catch(() => {});
  sessions.delete(pumpId);

  return session.totalSteps;
}

export function isCalibrating(pumpId: PumpId): boolean {
  return sessions.has(pumpId);
}
