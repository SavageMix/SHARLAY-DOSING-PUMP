import type { PumpId, RoutineStoppedBy } from '@reef/shared';

/**
 * Generic routine-run reconciliation (prime, calibration, ...).
 *
 * The device owns all stopping: a run ends only when the user presses Stop
 * (stoppedBy 'user') or the watchdog backstop fires (stoppedBy 'watchdog').
 * The app never ends a run from local timers — it only observes, folding
 * what the device reports (status polls and 409 rejections) into decisions.
 */

/** Minimum shape of a completed run result. */
export interface RoutineResult {
  pumpId: PumpId;
  totalSteps: number;
  stoppedBy: RoutineStoppedBy;
}

/** Stable per-run identity, used to surface a result exactly once. */
export function routineRunKey(
  result: Pick<RoutineResult, 'pumpId' | 'totalSteps'>,
): string {
  return `${result.pumpId}:${result.totalSteps}`;
}

export interface RoutineReconcileInput<
  T extends RoutineResult = RoutineResult,
> {
  /** Whether the app believes a run it started is still going. */
  localRunning: boolean;
  /** What the device reports: running true/false, or null when unknown. */
  deviceRunning: boolean | null;
  /** The device's most recent completed run result, if any. */
  lastResult: T | null;
  /** Runs already surfaced to the user (routineRunKey values). */
  handledKeys: ReadonlySet<string>;
  /**
   * True from the moment we start a run until a poll confirms the device
   * sees it. A poll already in flight before the start can report a stale
   * "not running" — it must not clear a run we just started or surface an
   * old result.
   */
  awaitingConfirmation: boolean;
}

export interface RoutineReconcileOutput<
  T extends RoutineResult = RoutineResult,
> {
  /** End the local run UI; the device owns all stopping. */
  clearLocalRunning: boolean;
  /** A completed run to surface (modal, save step), if any. */
  surfacedResult: T | null;
  handledKeys: Set<string>;
  awaitingConfirmation: boolean;
}

/**
 * Fold a device report into local state. By default only watchdog stops are
 * surfaced (prime's paused modal); routines whose non-watchdog ends are also
 * actionable (calibration's save step) can pass `() => true`.
 */
export function reconcileRoutine<T extends RoutineResult>(
  input: RoutineReconcileInput<T>,
  shouldSurface: (result: T) => boolean = (result) =>
    result.stoppedBy === 'watchdog',
): RoutineReconcileOutput<T> {
  const noop: RoutineReconcileOutput<T> = {
    clearLocalRunning: false,
    surfacedResult: null,
    handledKeys: new Set(input.handledKeys),
    awaitingConfirmation: input.awaitingConfirmation,
  };

  // No data yet — keep current state.
  if (input.deviceRunning === null) {
    return noop;
  }

  if (input.deviceRunning) {
    // Device confirms a run is active; a pending start is now confirmed.
    return { ...noop, awaitingConfirmation: false };
  }

  // Device reports no active run. A pre-start poll can land here while we
  // are still awaiting confirmation — it predates the start, so wait.
  if (input.awaitingConfirmation) {
    return noop;
  }

  // Only react when the end concerns a run WE were tracking. Otherwise an
  // old result would pop UI on a fresh screen load.
  if (!input.localRunning) {
    return { ...noop, awaitingConfirmation: false };
  }

  const handledKeys = new Set(input.handledKeys);
  let surfacedResult: T | null = null;

  const last = input.lastResult;
  if (last && shouldSurface(last)) {
    const key = routineRunKey(last);
    if (!handledKeys.has(key)) {
      handledKeys.add(key);
      surfacedResult = last;
    }
  }

  return {
    clearLocalRunning: true,
    surfacedResult,
    handledKeys,
    awaitingConfirmation: false,
  };
}

/**
 * Authoritative reconciliation after the server rejects a stop with a
 * "not running" 409: the session is already gone no matter what any
 * in-flight or stale poll claims, so this bypasses awaitingConfirmation.
 */
export function reconcileAfterRoutineGone<T extends RoutineResult>(
  input: Omit<RoutineReconcileInput<T>, 'deviceRunning' | 'awaitingConfirmation'>,
  shouldSurface?: (result: T) => boolean,
): RoutineReconcileOutput<T> {
  return reconcileRoutine<T>(
    { ...input, deviceRunning: false, awaitingConfirmation: false },
    shouldSurface,
  );
}

/**
 * True when a stop rejection means the session already ended on the device
 * (watchdog, restart) rather than a real failure. Never show this to the
 * user as an error — reconcile from /api/status instead.
 */
export function isRoutineGoneError(
  error: unknown,
  goneMessagePattern: RegExp,
): boolean {
  if ((error as { status?: number } | null)?.status === 409) return true;
  return error instanceof Error && goneMessagePattern.test(error.message);
}
