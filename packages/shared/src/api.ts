import type {
  ComputedDoseLimits,
  ContainerInfo,
  DoseEvent,
  DoseSchedule,
  MissedDose,
  PumpId,
  PumpState,
} from './types.js';

export interface DoseRequest {
  pumpId: PumpId;
  volumeMl: number;
}

export interface DoseResponse {
  event: DoseEvent;
}

export interface CalibrateStartRequest {
  pumpId: PumpId;
  /**
   * Optional hard backstop in steps. If omitted, calibration is capped at
   * a generous 9-minute runtime worth of steps (~432k at 800 Hz).
   */
  maxSteps?: number;
}

export interface CalibrateStartResponse {
  started: true;
}

export interface CalibrateStopRequest {
  pumpId: PumpId;
}

export interface CalibrateStopResponse {
  pumpId: PumpId;
  totalSteps: number;
  /** Additive: why the run ended — user stop or the watchdog backstop. */
  stoppedBy: CalibrateStoppedBy;
}

export interface CalibrateSaveRequest {
  pumpId: PumpId;
  measuredMl: number;
  totalSteps: number;
}

export interface CalibrateSaveResponse {
  pumpId: PumpId;
  stepsPerMl: number;
}

export interface StatusResponse {
  pumps: PumpState[];
  containers: ContainerInfo[];
  currentDose: DoseEvent | null;
  queue: DoseEvent[];
  queueDepth: number;
  systemVolumeLitres: number;
  prime: {
    priming: boolean;
    lastResult: PrimeResult | null;
  };
  calibration: {
    calibrating: boolean;
    lastResult: CalibrationResult | null;
  };
}

export interface RefillContainerRequest {
  pumpId: PumpId;
  containerSizeMl?: number;
}

export interface RefillContainerResponse {
  pumpId: PumpId;
  remainingMl: number;
  capacityMl: number;
}

export interface LimitsResponse {
  limits: {
    maxSingleDoseMl: number;
    maxDailyDoseMlPerPump: number;
    stepRateHz: number;
  };
  effective: ComputedDoseLimits;
}

export interface ListSchedulesResponse {
  schedules: DoseSchedule[];
}

export interface CreateScheduleRequest {
  pumpId: PumpId;
  volumeMl: number;
  timesPerDay: number;
  startTime: string;
  repeatEveryNDays: number;
  enabled?: boolean;
}

export interface CreateScheduleResponse {
  schedule: DoseSchedule;
}

export interface UpdateScheduleRequest {
  volumeMl?: number;
  timesPerDay?: number;
  startTime?: string;
  repeatEveryNDays?: number;
  enabled?: boolean;
}

export interface UpdateScheduleResponse {
  schedule: DoseSchedule;
}

export interface DeleteScheduleResponse {
  success: boolean;
}

export interface PrimeStartRequest {
  pumpId: PumpId;
}

export interface PrimeStartResponse {
  started: true;
}

export interface PrimeStopRequest {
  pumpId: PumpId;
}

/** Why a routine run ended: the user pressed Stop, or the watchdog backstop fired. */
export type RoutineStoppedBy = 'user' | 'watchdog';

export type PrimeStoppedBy = RoutineStoppedBy;
export type CalibrateStoppedBy = RoutineStoppedBy;

/**
 * Result of a completed calibration run, however it ended. A watchdog stop
 * is not a failure — the dispensed volume is still measurable, so the run
 * can be folded straight into the save step.
 */
export interface CalibrationResult {
  pumpId: PumpId;
  totalSteps: number;
  stoppedBy: CalibrateStoppedBy;
}

/**
 * Result of a completed prime run, however it ended. A watchdog stop is a
 * normal, expected outcome (long lines may need several runs), NOT an error.
 */
export interface PrimeResult {
  pumpId: PumpId;
  totalSteps: number;
  approxMl: number | null;
  stoppedBy: PrimeStoppedBy;
}

export type PrimeStopResponse = PrimeResult;

export interface HistoryQuery {
  pumpId?: PumpId;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryResponse {
  events: DoseEvent[];
  total: number;
}

export interface ListMissedDosesResponse {
  missedDoses: MissedDose[];
}

export interface ConfirmMissedDoseResponse {
  missedDose: MissedDose;
  jobId: string;
}

export interface DismissMissedDoseResponse {
  missedDose: MissedDose;
}
