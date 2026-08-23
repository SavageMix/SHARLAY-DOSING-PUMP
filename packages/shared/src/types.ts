export type PumpId = 'alk' | 'ca' | 'no3' | 'po4';

export interface DoseSchedule {
  id: string;
  pumpId: PumpId;
  volumeMl: number;
  timesPerDay: number;
  startTime: string; // HH:mm
  repeatEveryNDays: number;
  enabled: boolean;
  lastRunAt: string | null;
}

export interface PumpState {
  pumpId: PumpId;
  enabled: boolean;
  calibrated: boolean;
  stepsPerMl: number | null;
  todayDoseMl: number;
  containerRemainingMl: number;
}

export type DoseSource = 'manual' | 'schedule' | 'calibration';

export type DoseEventStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface DoseEvent {
  id: string;
  pumpId: PumpId;
  requestedMl: number;
  actualMl: number | null;
  status: DoseEventStatus;
  source: DoseSource;
  scheduleId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ContainerInfo {
  pumpId: PumpId;
  capacityMl: number;
  remainingMl: number;
  lastRefilledAt: string | null;
}

export interface SystemSettings {
  systemVolumeLitres: number;
}

export interface ComputedDoseLimits {
  systemVolumeLitres: number;
  maxSingleDoseMl: number;
  maxDailyDoseMlPerPump: number;
  rates: {
    maxSingleDoseMlPerLitre: number;
    maxDailyDoseMlPerLitre: number;
  };
  hardLimits: {
    maxSingleDoseMl: number;
    maxDailyDoseMlPerPump: number;
  };
}
