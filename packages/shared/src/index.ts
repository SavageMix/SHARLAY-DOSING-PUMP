export const REEF_DOSER_VERSION = '1.0.0';

export type PumpChannel = 'alk' | 'ca' | 'no3' | 'po4';

export interface PumpConfig {
  channel: PumpChannel;
  stepsPerMl: number;
  maxSingleDoseMl: number;
  maxDailyDoseMl: number;
}

// Non-negotiable safety limits enforced by the dosing engine, never the UI.
export const SAFETY_MAX_SINGLE_DOSE_ML = 5;
export const SAFETY_MAX_DAILY_DOSE_ML = 25;
