import type { PrimeResult } from '@reef/shared';

/**
 * Prime-state reconciliation.
 *
 * The device owns all stopping: a prime run ends only when the user presses
 * Stop (stoppedBy 'user') or the watchdog backstop fires (stoppedBy
 * 'watchdog'). The app never stops a run from its own countdown — it only
 * observes. These helpers fold what the device reports (status polls and
 * 409 rejections) into decisions the settings screen can apply directly.
 */

/** Stable per-run identity, used to surface the paused modal exactly once. */
export function primeRunKey(
  result: Pick<PrimeResult, 'pumpId' | 'totalSteps'>,
): string {
  return `${result.pumpId}:${result.totalSteps}`;
}

export interface PrimeReconcileInput {
  /** Whether the app believes a prime it started is still running. */
  localPriming: boolean;
  /** What the device reports: priming true/false, or null when unknown. */
  devicePriming: boolean | null;
  /** The device's most recent completed prime result, if any. */
  lastResult: PrimeResult | null;
  /** Watchdog stops already surfaced to the user (primeRunKey values). */
  handledKeys: ReadonlySet<string>;
  /**
   * True from the moment we start a prime until a poll confirms the device
   * sees it. A poll already in flight before the start can report a stale
   * "not priming" — it must not clear a run we just started or pop a modal
   * for an old watchdog result.
   */
  awaitingConfirmation: boolean;
}

export interface PrimeReconcileOutput {
  /** Clear the local prime timer/state; the device owns all stopping. */
  clearLocalPrime: boolean;
  /** Show the "Priming paused" modal for this watchdog stop, if any. */
  showWatchdogModal: PrimeResult | null;
  handledKeys: Set<string>;
  awaitingConfirmation: boolean;
}

export function reconcilePrime(
  input: PrimeReconcileInput,
): PrimeReconcileOutput {
  const noop: PrimeReconcileOutput = {
    clearLocalPrime: false,
    showWatchdogModal: null,
    handledKeys: new Set(input.handledKeys),
    awaitingConfirmation: input.awaitingConfirmation,
  };

  // No data yet — keep current state.
  if (input.devicePriming === null) {
    return noop;
  }

  if (input.devicePriming) {
    // Device confirms a prime is running; a pending start is now confirmed.
    return { ...noop, awaitingConfirmation: false };
  }

  // Device reports no active prime. A pre-start poll can land here while we
  // are still awaiting confirmation — it predates the start, so wait.
  if (input.awaitingConfirmation) {
    return noop;
  }

  // Only react when the end concerns a run WE were tracking. Otherwise an
  // old watchdog result would pop the modal on a fresh app load.
  if (!input.localPriming) {
    return { ...noop, awaitingConfirmation: false };
  }

  const handledKeys = new Set(input.handledKeys);
  let showWatchdogModal: PrimeResult | null = null;

  const last = input.lastResult;
  if (last?.stoppedBy === 'watchdog') {
    const key = primeRunKey(last);
    if (!handledKeys.has(key)) {
      handledKeys.add(key);
      showWatchdogModal = last;
    }
  }

  return {
    clearLocalPrime: true,
    showWatchdogModal,
    handledKeys,
    awaitingConfirmation: false,
  };
}

/**
 * Authoritative reconciliation after the server rejects stopPrime with
 * "No prime running" (409): the session is already gone no matter what any
 * in-flight or stale poll claims, so this bypasses awaitingConfirmation.
 */
export function reconcileAfterPrimeGone(input: {
  localPriming: boolean;
  lastResult: PrimeResult | null;
  handledKeys: ReadonlySet<string>;
}): PrimeReconcileOutput {
  return reconcilePrime({
    localPriming: input.localPriming,
    devicePriming: false,
    lastResult: input.lastResult,
    handledKeys: input.handledKeys,
    awaitingConfirmation: false,
  });
}

/**
 * True when a stopPrime rejection means the session already ended on the
 * device (watchdog, restart) rather than a real failure. This must NEVER be
 * shown to the user as an error — the app reconciles from /api/status
 * instead.
 */
export function isPrimeGoneError(error: unknown): boolean {
  if ((error as { status?: number } | null)?.status === 409) return true;
  return error instanceof Error && /no prime running/i.test(error.message);
}
