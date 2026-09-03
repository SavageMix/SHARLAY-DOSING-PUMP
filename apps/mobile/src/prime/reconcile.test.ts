import { describe, expect, it } from 'vitest';
import type { PrimeResult } from '@reef/shared';
import {
  isPrimeGoneError,
  primeRunKey,
  reconcileAfterPrimeGone,
  reconcilePrime,
} from './reconcile';

const watchdogResult: PrimeResult = {
  pumpId: 'no3',
  totalSteps: 432_000,
  approxMl: 30.7,
  stoppedBy: 'watchdog',
};

const userResult: PrimeResult = { ...watchdogResult, stoppedBy: 'user' };

const empty = new Set<string>();

describe('reconcilePrime (poll path)', () => {
  it('keeps local state while the device reports priming and confirms a pending start', () => {
    const outcome = reconcilePrime({
      localPriming: true,
      devicePriming: true,
      lastResult: null,
      handledKeys: empty,
      awaitingConfirmation: true,
    });
    expect(outcome.clearLocalPrime).toBe(false);
    expect(outcome.showWatchdogModal).toBeNull();
    expect(outcome.awaitingConfirmation).toBe(false);
  });

  it('ignores a stale pre-start poll while awaiting confirmation', () => {
    // A poll that left the device before we tapped Prime reports "not
    // priming" — it must not clear the run we just started, nor pop a modal
    // for an old, unhandled watchdog result.
    const outcome = reconcilePrime({
      localPriming: true,
      devicePriming: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: true,
    });
    expect(outcome.clearLocalPrime).toBe(false);
    expect(outcome.showWatchdogModal).toBeNull();
    expect(outcome.handledKeys.size).toBe(0);
  });

  it('clears the timer and shows the paused modal on a late-detected watchdog stop', () => {
    // Phone locked right after tapping Prime: no poll ever saw priming=true,
    // and the first poll after resume reports priming=false with the
    // watchdog result. This is the regression the transition-based detector
    // missed.
    const outcome = reconcilePrime({
      localPriming: true,
      devicePriming: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(outcome.clearLocalPrime).toBe(true);
    expect(outcome.showWatchdogModal).toEqual(watchdogResult);
    expect(outcome.handledKeys.has(primeRunKey(watchdogResult))).toBe(true);
  });

  it('clears without a modal when the run ended with a user stop', () => {
    const outcome = reconcilePrime({
      localPriming: true,
      devicePriming: false,
      lastResult: userResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(outcome.clearLocalPrime).toBe(true);
    expect(outcome.showWatchdogModal).toBeNull();
  });

  it('does not pop a stale watchdog modal on a fresh app load', () => {
    const outcome = reconcilePrime({
      localPriming: false,
      devicePriming: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(outcome.clearLocalPrime).toBe(false);
    expect(outcome.showWatchdogModal).toBeNull();
  });

  it('does nothing when there is no device data yet', () => {
    const outcome = reconcilePrime({
      localPriming: true,
      devicePriming: null,
      lastResult: null,
      handledKeys: empty,
      awaitingConfirmation: true,
    });
    expect(outcome.clearLocalPrime).toBe(false);
    expect(outcome.showWatchdogModal).toBeNull();
    expect(outcome.awaitingConfirmation).toBe(true);
  });
});

describe('reconcileAfterPrimeGone (stopPrime 409 path)', () => {
  it('REGRESSION: watchdog ends session → stopPrime 409 → reconcile via /api/status shows modal, no error', () => {
    // 1. The device watchdog ends the prime session while the app still
    //    believes it is running.
    // 2. The user presses Stop; the server answers 409 "No prime running
    //    for no3" — recognized as a reconciliation signal, not a failure.
    expect(isPrimeGoneError(new Error('No prime running for no3'))).toBe(true);

    // 3. The app fetches /api/status and reconciles from it.
    const status = { priming: false, lastResult: watchdogResult };
    const outcome = reconcileAfterPrimeGone({
      localPriming: true,
      lastResult: status.lastResult,
      handledKeys: empty,
    });

    // 4. Local timer cleared, paused modal shown — no error text produced.
    expect(outcome.clearLocalPrime).toBe(true);
    expect(outcome.showWatchdogModal).toEqual(watchdogResult);
    expect(outcome.showWatchdogModal?.stoppedBy).toBe('watchdog');
  });

  it('shows the modal once even when the poll transition and the 409 both detect the same stop', () => {
    // Poll transition detects the watchdog stop first.
    const viaPoll = reconcilePrime({
      localPriming: true,
      devicePriming: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(viaPoll.showWatchdogModal).toEqual(watchdogResult);

    // The user's Stop press then 409s on the same ended session.
    const via409 = reconcileAfterPrimeGone({
      localPriming: true,
      lastResult: watchdogResult,
      handledKeys: viaPoll.handledKeys,
    });
    expect(via409.clearLocalPrime).toBe(true);
    expect(via409.showWatchdogModal).toBeNull();
    expect(via409.handledKeys.size).toBe(1);
  });

  it('does not mistake a real failure for a gone session', () => {
    expect(isPrimeGoneError(new Error('HTTP 500'))).toBe(false);
    expect(isPrimeGoneError(new Error('Network request failed'))).toBe(false);
    expect(isPrimeGoneError(null)).toBe(false);
    expect(isPrimeGoneError({ status: 409 })).toBe(true);
  });
});
