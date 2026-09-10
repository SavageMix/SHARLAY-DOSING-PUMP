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
  /** True when the next scheduled occurrence for this pump will be skipped. */
  skipNext: boolean;
}

export type DoseSource =
  | 'manual'
  | 'schedule'
  | 'catchup'
  | 'calibration'
  | 'prime';

export type DoseEventStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'skipped'
  | 'interrupted';

export type MissedDoseStatus =
  | 'pending'
  | 'confirmed'
  | 'dismissed'
  | 'expired'
  /** Terminal: the catch-up dose fired and delivered. */
  | 'completed'
  /** Terminal: the catch-up dose was submitted but failed (e.g. caps, hardware). */
  | 'failed'
  /** Terminal: the catch-up was interrupted mid-run by a process death. */
  | 'interrupted';

export interface DoseEvent {
  id: string;
  pumpId: PumpId;
  requestedMl: number;
  actualMl: number | null;
  status: DoseEventStatus;
  source: DoseSource;
  scheduleId: string | null;
  /**
   * Set when source is 'catchup': the missed_doses entry this dose fulfils.
   * Lets the engine atomically close the entry when the dose completes, and
   * lets boot reconciliation recover entries whose fire was cut short.
   */
  missedDoseId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /**
   * Server-side enrichment (not stored on the event): the wall-clock time of
   * the missed slot, so History/UI can say "Catch-up — missed 06:00".
   */
  missedDoseScheduledFor?: string | null;
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
