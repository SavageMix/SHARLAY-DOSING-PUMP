import type { ComputedDoseLimits } from './types.js';

/**
 * Dose rate constants. Tunable by us between releases; never user-editable.
 */
export const LIMIT_RATES = {
  maxSingleDoseMlPerLitre: 0.013,
  maxDailyDoseMlPerLitre: 0.065,
} as const;

/**
 * Absolute backstop limits. No override, no bypass.
 */
export const HARD_LIMITS = {
  maxSingleDoseMl: 100,
  maxDailyDoseMlPerPump: 500,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeMaxSingleDoseMl(systemVolumeLitres: number): number {
  return clamp(
    systemVolumeLitres * LIMIT_RATES.maxSingleDoseMlPerLitre,
    1,
    HARD_LIMITS.maxSingleDoseMl,
  );
}

export function computeMaxDailyDoseMlPerPump(
  systemVolumeLitres: number,
): number {
  return clamp(
    systemVolumeLitres * LIMIT_RATES.maxDailyDoseMlPerLitre,
    5,
    HARD_LIMITS.maxDailyDoseMlPerPump,
  );
}

export function computeDoseLimits(
  systemVolumeLitres: number,
): ComputedDoseLimits {
  return {
    systemVolumeLitres,
    maxSingleDoseMl: computeMaxSingleDoseMl(systemVolumeLitres),
    maxDailyDoseMlPerPump: computeMaxDailyDoseMlPerPump(systemVolumeLitres),
    rates: { ...LIMIT_RATES },
    hardLimits: { ...HARD_LIMITS },
  };
}
