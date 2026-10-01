import { SYSTEM_VOLUME_BOUNDS } from '@reef/shared';

/**
 * Validation for the editable system volume setting (Settings screen).
 * The device re-validates on POST /api/system/volume; this exists so bad
 * input is caught (and explained) before a request is ever sent.
 */

export type SystemVolumeValidation =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function validateSystemVolumeInput(raw: string): SystemVolumeValidation {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === '' || Number.isNaN(value)) {
    return { ok: false, error: 'Enter a number of litres' };
  }
  if (value < SYSTEM_VOLUME_BOUNDS.minLitres) {
    return {
      ok: false,
      error: `Minimum system volume is ${SYSTEM_VOLUME_BOUNDS.minLitres} L`,
    };
  }
  if (value > SYSTEM_VOLUME_BOUNDS.maxLitres) {
    return {
      ok: false,
      error: `Maximum system volume is ${SYSTEM_VOLUME_BOUNDS.maxLitres} L`,
    };
  }
  return { ok: true, value };
}
