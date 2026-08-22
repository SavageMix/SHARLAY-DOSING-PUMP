export const REEF_DOSER_VERSION = '1.0.0';

export type PumpChannel = 'alk' | 'ca' | 'no3' | 'po4';

export interface PumpConfig {
  channel: PumpChannel;
  stepsPerMl: number;
  maxSingleDoseMl: number;
  maxDailyDoseMl: number;
}
