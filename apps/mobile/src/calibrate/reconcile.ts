import type { CalibrationResult } from '@reef/shared';
import {
  isRoutineGoneError,
  reconcileAfterRoutineGone,
  reconcileRoutine,
  routineRunKey,
} from '../lib/reconcile-routine';

/**
 * Calibration-run reconciliation.
 *
 * Same state machine as prime (src/lib/reconcile-routine), with one
 * deliberate difference: ANY completed run is surfaced, not just watchdog
 * stops. A watchdog-ended calibration is still usable — the user can
 * measure what was dispensed and save — so the wizard folds the result
 * straight into its save step instead of showing an error.
 */

export const calibrationRunKey = routineRunKey;

export interface CalibrationReconcileInput {
  /** Whether the wizard believes its run is still going. */
  localCalibrating: boolean;
  /** What /api/status reports (null = no data yet). */
  deviceCalibrating: boolean | null;
  lastResult: CalibrationResult | null;
  handledKeys: ReadonlySet<string>;
  awaitingConfirmation: boolean;
}

export interface CalibrationReconcileOutput {
  /** End the local run UI; the device owns all stopping. */
  clearLocalCalibration: boolean;
  /** A completed run to fold into the save step, if any. */
  foldInResult: CalibrationResult | null;
  handledKeys: Set<string>;
  awaitingConfirmation: boolean;
}

function mapOutcome(
  outcome: ReturnType<typeof reconcileRoutine<CalibrationResult>>,
): CalibrationReconcileOutput {
  return {
    clearLocalCalibration: outcome.clearLocalRunning,
    foldInResult: outcome.surfacedResult,
    handledKeys: outcome.handledKeys,
    awaitingConfirmation: outcome.awaitingConfirmation,
  };
}

export function reconcileCalibration(
  input: CalibrationReconcileInput,
): CalibrationReconcileOutput {
  return mapOutcome(
    reconcileRoutine<CalibrationResult>(
      {
        localRunning: input.localCalibrating,
        deviceRunning: input.deviceCalibrating,
        lastResult: input.lastResult,
        handledKeys: input.handledKeys,
        awaitingConfirmation: input.awaitingConfirmation,
      },
      () => true,
    ),
  );
}

/**
 * Authoritative reconciliation after stopCalibration answers
 * "No calibration running" (409): the session is already gone no matter
 * what any in-flight or stale poll claims, so this bypasses
 * awaitingConfirmation.
 */
export function reconcileAfterCalibrationGone(input: {
  localCalibrating: boolean;
  lastResult: CalibrationResult | null;
  handledKeys: ReadonlySet<string>;
}): CalibrationReconcileOutput {
  return mapOutcome(
    reconcileAfterRoutineGone<CalibrationResult>(
      {
        localRunning: input.localCalibrating,
        lastResult: input.lastResult,
        handledKeys: input.handledKeys,
      },
      () => true,
    ),
  );
}

/**
 * True when a stopCalibration rejection means the session already ended on
 * the device (watchdog, restart) rather than a real failure. Never show
 * this to the user as an error — reconcile from /api/status instead.
 */
export function isCalibrationGoneError(error: unknown): boolean {
  return isRoutineGoneError(error, /no calibration running/i);
}
