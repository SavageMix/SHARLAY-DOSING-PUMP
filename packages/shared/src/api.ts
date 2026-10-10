import type {
  ComputedDoseLimits,
  Container,
  ContainerInfo,
  ContainerStatus,
  DoseEvent,
  DoseSchedule,
  DoseSource,
  MissedDose,
  PumpId,
  PumpState,
} from './types.js';

export interface DoseRequest {
  pumpId: PumpId;
  volumeMl: number;
}

export interface DoseResponse {
  /**
   * Id of the queued dose job. Once the engine starts executing the dose,
   * this same id is the DoseEvent id surfaced in /api/status.
   */
  jobId: string;
}

/**
 * A dose waiting in the engine FIFO (any source), as exposed on
 * /api/status's `queueItems`. `id` is the jobId returned by POST /api/dose
 * and later the DoseEvent id — for a queued manual dose it is what a cancel
 * request references. Position in the array IS the queue position (1-based
 * from the front when the current dose is counted separately by the UI).
 */
export interface DoseQueueItem {
  id: string;
  pumpId: PumpId;
  amountMl: number;
  source: DoseSource;
  /** Wall-clock estimate of when the engine expects to fire it. */
  estimatedFireAt: string;
}

export interface CancelDoseResponse {
  jobId: string;
  cancelled: true;
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

/**
 * A catch-up dose that is firing now or waiting in the engine queue.
 * `missedDoseScheduledFor` is the original wall-clock slot the dose was
 * missed at (device-local); `estimatedFireAt` is when the engine expects to
 * fire it, honouring the minimum inter-dose gap. Estimates assume instant
 * dose durations, hence "~" prefixes in the UI.
 */
export interface CatchupQueueItem {
  pumpId: PumpId;
  missedDoseId: string;
  missedDoseScheduledFor: string | null;
  estimatedFireAt: string | null;
}

export interface CatchupQueueStatus {
  firing: CatchupQueueItem | null;
  queued: CatchupQueueItem[];
  /**
   * Confirmed catch-ups not yet in a terminal state — in flight, in the
   * engine queue, or scheduled at a future confirmAfter. Includes items not
   * yet visible in `queued`, so the UI can show drain progress ("23 of 36
   * remaining") during multi-hour staggered drains.
   */
  remaining: number;
  /**
   * Earliest upcoming fire time (minimum confirmAfter across confirmed
   * entries), or null when nothing is scheduled — e.g. only an in-flight
   * dose remains.
   */
  nextFireAt: string | null;
}

/**
 * A discrepancy found by the boot-time integrity audit (SELECT-only — the
 * audit never repairs, fires, or dismisses anything). `id` is stable so the
 * app can let the user dismiss a finding locally without it resurfacing on
 * every refresh; dismissal never touches the underlying records.
 */
export type IntegrityCheckKind =
  /** missed_doses 'completed' with no (or several) linked dose_events row. */
  | 'completed-without-event'
  /** dose_events source 'catchup' with no matching missed_doses row. */
  | 'orphan-catchup-event'
  /** A past schedule slot has neither a handled dose event nor a missed-dose entry. */
  | 'unresolved-slot'
  /** A reservoir's current_ml is at or below its low_threshold_ml. */
  | 'container-low';

export interface IntegrityFinding {
  /** Stable key, e.g. "completed-without-event:<missedDoseId>". */
  id: string;
  check: IntegrityCheckKind;
  /** Plain English, suitable for showing the owner directly. */
  message: string;
  pumpId?: PumpId;
  /** Original wall-clock slot (ISO), when the finding concerns one. */
  missedSlotIso?: string;
}

export interface StatusResponse {
  pumps: PumpState[];
  containers: ContainerInfo[];
  currentDose: DoseEvent | null;
  queue: DoseEvent[];
  queueDepth: number;
  /**
   * Every dose waiting in the engine FIFO, in firing order (index 0 fires
   * next), with job ids. Present on current device builds; absent on older
   * firmware, where the app falls back to `queue`/`queueDepth` only.
   */
  queueItems?: DoseQueueItem[];
  catchupQueue: CatchupQueueStatus;
  /** Live integrity audit findings; empty when the record agrees with itself. */
  integrityFindings: IntegrityFinding[];
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

// ---------------------------------------------------------------------------
// Reservoir tracking (dedicated `containers` table)
// ---------------------------------------------------------------------------

/** Response for GET /api/containers. */
export interface ListContainersResponse {
  containers: ContainerStatus[];
}

/**
 * POST /api/containers/:pump/refill — without volume_ml the reservoir resets
 * to full (current_ml = capacity_ml); with volume_ml it is set to that
 * partial-refill level (clamped to capacity).
 */
export interface RefillReservoirRequest {
  volumeMl?: number;
}

/** POST /api/containers/:pump/adjust — manual level correction. */
export interface AdjustReservoirRequest {
  currentMl: number;
}

/** PATCH /api/containers/:pump — edit name, capacity, and/or low threshold. */
export interface UpdateReservoirRequest {
  name?: string;
  capacityMl?: number;
  lowThresholdMl?: number;
}

/** Single-reservoir responses share one shape: the enriched container. */
export interface ReservoirResponse {
  container: ContainerStatus;
}

export type { Container, ContainerStatus };

/** Response for POST /api/pumps/:id/skip-next and .../skip-next/cancel. */
export interface SkipNextDoseResponse {
  pumpId: PumpId;
  /** Whether the next scheduled occurrence for this pump will be skipped. */
  skipNext: boolean;
  /** The occurrence the skip applies to (ISO), or null when not skipping. */
  skipScheduledFor: string | null;
}

export interface LimitsResponse {
  limits: {
    maxSingleDoseMl: number;
    maxDailyDoseMlPerPump: number;
    stepRateHz: number;
  };
  effective: ComputedDoseLimits;
}

/** Request for POST /api/system/volume. Bounds enforced device-side too. */
export interface SetSystemVolumeRequest {
  systemVolumeLitres: number;
}

export interface SetSystemVolumeResponse {
  systemVolumeLitres: number;
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

/** Query params for GET /api/missed-doses. */
export interface ListMissedDosesParams {
  /** Include pending entries whose 1h snooze hasn't expired. */
  includeSnoozed?: boolean;
  /**
   * Also return confirmed entries (catch-ups the user confirmed but which
   * haven't fired yet) so the UI can show them as a removable queued state.
   * Confirmed entries are never snooze-hidden.
   */
  includeConfirmed?: boolean;
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

/**
 * Withdraw a confirmed-but-not-yet-fired catch-up. Terminal status is
 * 'cancelled' (distinct from 'dismissed' = refused while pending) so History
 * can tell "user changed their mind" from "user refused the dose". Rejected
 * (409) when the entry is not confirmed or its dose is already firing.
 */
export interface CancelMissedDoseResponse {
  missedDose: MissedDose;
}

/** Result of the bulk drain escape: POST /api/missed-doses/cancel-all. */
export interface CancelAllMissedDosesResponse {
  /** Entries withdrawn (now status 'cancelled'). */
  cancelled: string[];
  /**
   * Confirmed entries whose dose was already firing and could NOT be
   * withdrawn — they complete normally. The UI should refresh to show this.
   */
  inFlight: string[];
}

/** "Decide later": hide all pending entries until `until` (default +60 min). */
export interface SnoozeMissedDosesRequest {
  until?: string;
}

export interface SnoozeMissedDosesResponse {
  deferredUntil: string;
}

/** Batch-confirm selected catch-up doses. */
export interface ConfirmMissedDosesRequest {
  ids: string[];
}

export interface ConfirmMissedDosesResponse {
  /** Dose ids submitted to the engine immediately. */
  fired: string[];
  /** Dose ids confirmed but delayed for per-pump spacing (see confirmAfter). */
  scheduled: string[];
  /** Dose ids NOT fired because a safety cap would be exceeded. */
  dropped: Array<{ id: string; reason: string }>;
}

/** Batch-dismiss (permanent) — used for "Skip all" and unselected leftovers. */
export interface DismissMissedDosesRequest {
  ids: string[];
}

export interface DismissMissedDosesResponse {
  dismissed: string[];
}
