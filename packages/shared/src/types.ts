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

export type DoseSource = 'manual' | 'schedule' | 'calibration' | 'prime';

export type DoseEventStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export type MissedDoseStatus =
  | 'pending'
  | 'confirmed'
  | 'dismissed'
  | 'expired';

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

export interface MissedDose {
  id: string;
  scheduleId: string;
  pumpId: PumpId;
  scheduledFor: string;
  volumeMl: number;
  status: MissedDoseStatus;
  createdAt: string;
  /**
   * Snooze horizon set by "Decide later". While in the future, the device
   * hides this entry from GET /api/missed-doses. Its presence (in the past)
   * on a returned entry tells the app this is a forced re-prompt.
   */
  deferredUntil: string | null;
  /**
   * Set when a catch-up dose is confirmed but deliberately delayed (per-pump
   * minimum spacing between catch-up doses). The scheduler fires it once
   * confirmAfter passes, then clears the field.
   */
  confirmAfter: string | null;
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
