import { describe, expect, it } from 'vitest';
import type { CalibrationResult } from '@reef/shared';
import {
  calibrationRunKey,
  isCalibrationGoneError,
  reconcileAfterCalibrationGone,
  reconcileCalibration,
} from './reconcile';

const watchdogResult: CalibrationResult = {
  pumpId: 'ca',
  totalSteps: 432_000,
  stoppedBy: 'watchdog',
};

const userResult: CalibrationResult = {
  pumpId: 'ca',
  totalSteps: 140_480,
  stoppedBy: 'user',
};

const empty = new Set<string>();

describe('reconcileCalibration (poll path)', () => {
  it('keeps the run UI while the device reports calibrating and confirms a pending start', () => {
    const outcome = reconcileCalibration({
      localCalibrating: true,
      deviceCalibrating: true,
      lastResult: null,
      handledKeys: empty,
      awaitingConfirmation: true,
    });
    expect(outcome.clearLocalCalibration).toBe(false);
    expect(outcome.foldInResult).toBeNull();
    expect(outcome.awaitingConfirmation).toBe(false);
  });

  it('ignores a stale pre-start poll while awaiting confirmation', () => {
    // A poll that left the device before START was pressed reports "not
    // calibrating" — it must not end the run UI we just started, nor fold
    // in an old result.
    const outcome = reconcileCalibration({
      localCalibrating: true,
      deviceCalibrating: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: true,
    });
    expect(outcome.clearLocalCalibration).toBe(false);
    expect(outcome.foldInResult).toBeNull();
    expect(outcome.handledKeys.size).toBe(0);
  });

  it('REGRESSION: suspended polls → resume → watchdog-ended run folds into the save step', () => {
    // Phone locked right after pressing START: no poll ever saw
    // calibrating=true, and the first poll after resume reports
    // calibrating=false with the watchdog result. The wizard must end the
    // run UI and offer the result for saving — no error, no lost run.
    const outcome = reconcileCalibration({
      localCalibrating: true,
      deviceCalibrating: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(outcome.clearLocalCalibration).toBe(true);
    expect(outcome.foldInResult).toEqual(watchdogResult);
    expect(outcome.foldInResult?.totalSteps).toBe(432_000);
    expect(outcome.handledKeys.has(calibrationRunKey(watchdogResult))).toBe(
      true,
    );
  });

  it('folds in a user-ended run too (e.g. another client stopped it)', () => {
    const outcome = reconcileCalibration({
      localCalibrating: true,
      deviceCalibrating: false,
      lastResult: userResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(outcome.clearLocalCalibration).toBe(true);
    expect(outcome.foldInResult).toEqual(userResult);
  });

  it('does not fold an old result into a fresh wizard', () => {
    const outcome = reconcileCalibration({
      localCalibrating: false,
      deviceCalibrating: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(outcome.clearLocalCalibration).toBe(false);
    expect(outcome.foldInResult).toBeNull();
  });

  it('does nothing when there is no device data yet', () => {
    const outcome = reconcileCalibration({
      localCalibrating: true,
      deviceCalibrating: null,
      lastResult: null,
      handledKeys: empty,
      awaitingConfirmation: true,
    });
    expect(outcome.clearLocalCalibration).toBe(false);
    expect(outcome.foldInResult).toBeNull();
    expect(outcome.awaitingConfirmation).toBe(true);
  });
});

describe('reconcileAfterCalibrationGone (stopCalibration 409 path)', () => {
  it('REGRESSION: watchdog ends session → stopCalibration 409 → reconcile via /api/status folds the result in, no error', () => {
    // 1. The device watchdog ends the run while the wizard still believes
    //    it is running.
    // 2. The user presses STOP; the server answers 409 "No calibration
    //    running for ca" — a reconciliation signal, not a failure.
    expect(
      isCalibrationGoneError(new Error('No calibration running for ca')),
    ).toBe(true);

    // 3. The wizard fetches /api/status and reconciles from it.
    const status = { calibrating: false, lastResult: watchdogResult };
    const outcome = reconcileAfterCalibrationGone({
      localCalibrating: true,
      lastResult: status.lastResult,
      handledKeys: empty,
    });

    // 4. Run UI ends, result offered for saving — no error text produced.
    expect(outcome.clearLocalCalibration).toBe(true);
    expect(outcome.foldInResult).toEqual(watchdogResult);
  });

  it('folds in a run once even when the poll transition and the 409 both detect it', () => {
    // Poll detects the ended run first.
    const viaPoll = reconcileCalibration({
      localCalibrating: true,
      deviceCalibrating: false,
      lastResult: watchdogResult,
      handledKeys: empty,
      awaitingConfirmation: false,
    });
    expect(viaPoll.foldInResult).toEqual(watchdogResult);

    // The user's STOP press then 409s on the same ended session.
    const via409 = reconcileAfterCalibrationGone({
      localCalibrating: true,
      lastResult: watchdogResult,
      handledKeys: viaPoll.handledKeys,
    });
    expect(via409.clearLocalCalibration).toBe(true);
    expect(via409.foldInResult).toBeNull();
    expect(via409.handledKeys.size).toBe(1);
  });

  it('clears the run UI when the device has no result (e.g. after a reboot)', () => {
    const outcome = reconcileAfterCalibrationGone({
      localCalibrating: true,
      lastResult: null,
      handledKeys: empty,
    });
    expect(outcome.clearLocalCalibration).toBe(true);
    expect(outcome.foldInResult).toBeNull();
  });

  it('does not mistake a real failure for a gone session', () => {
    expect(isCalibrationGoneError(new Error('HTTP 500'))).toBe(false);
    expect(isCalibrationGoneError(new Error('Network request failed'))).toBe(
      false,
    );
    expect(isCalibrationGoneError(null)).toBe(false);
    expect(isCalibrationGoneError({ status: 409 })).toBe(true);
  });
});
