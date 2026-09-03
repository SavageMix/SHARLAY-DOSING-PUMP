import type { PrimeResult } from '@reef/shared';
import {
  isRoutineGoneError,
  reconcileAfterRoutineGone,
  reconcileRoutine,
  routineRunKey,
  type RoutineReconcileInput,
  type RoutineReconcileOutput,
} from '../lib/reconcile-routine';

/**
 * Prime-state reconciliation.
 *
 * The device owns all stopping: a prime run ends only when the user presses
 * Stop (stoppedBy 'user') or the watchdog backstop fires (stoppedBy
 * 'watchdog'). The app never stops a run from its own countdown — it only
 * observes. The generic state machine lives in src/lib/reconcile-routine;
 * this module pins the prime-specific names and the watchdog-only surface
 * rule (prime only shows the paused modal; a user stop needs no modal).
 */

export const primeRunKey = routineRunKey;

export type PrimeReconcileInput = RoutineReconcileInput<PrimeResult>;
export type PrimeReconcileOutput = RoutineReconcileOutput<PrimeResult>;

function mapOutcome(
  outcome: RoutineReconcileOutput<PrimeResult>,
): PrimeReconcileOutput {
  return {
    clearLocalPrime: outcome.clearLocalRunning,
    showWatchdogModal: outcome.surfacedResult,
    handledKeys: outcome.handledKeys,
    awaitingConfirmation: outcome.awaitingConfirmation,
  };
}

export function reconcilePrime(input: {
  /** Whether the app believes a prime it started is still running. */
  localPriming: boolean;
  /** What /api/status reports (null = no data yet). */
  devicePriming: boolean | null;
  lastResult: PrimeResult | null;
  handledKeys: ReadonlySet<string>;
  awaitingConfirmation: boolean;
}): PrimeReconcileOutput {
  return mapOutcome(
    reconcileRoutine<PrimeResult>({
      localRunning: input.localPriming,
      deviceRunning: input.devicePriming,
      lastResult: input.lastResult,
      handledKeys: input.handledKeys,
      awaitingConfirmation: input.awaitingConfirmation,
    }),
  );
}

/**
 * Authoritative reconciliation after stopPrime answers "No prime running"
 * (409): the session is already gone no matter what any in-flight or stale
 * poll claims, so this bypasses awaitingConfirmation.
 */
export function reconcileAfterPrimeGone(input: {
  localPriming: boolean;
  lastResult: PrimeResult | null;
  handledKeys: ReadonlySet<string>;
}): PrimeReconcileOutput {
  return mapOutcome(
    reconcileAfterRoutineGone<PrimeResult>({
      localRunning: input.localPriming,
      lastResult: input.lastResult,
      handledKeys: input.handledKeys,
    }),
  );
}

/**
 * True when a stopPrime rejection means the session already ended on the
 * device (watchdog, restart) rather than a real failure. This must NEVER be
 * shown to the user as an error — the app reconciles from /api/status
 * instead.
 */
export function isPrimeGoneError(error: unknown): boolean {
  return isRoutineGoneError(error, /no prime running/i);
}
