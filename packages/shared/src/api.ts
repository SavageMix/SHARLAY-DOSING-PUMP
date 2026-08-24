import type {
  ComputedDoseLimits,
  ContainerInfo,
  DoseEvent,
  DoseSchedule,
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
}

export interface CalibrateStartResponse {
  started: true;
}

export interface CalibrateStopRequest {
  pumpId: PumpId;
  measuredMl: number;
}

export interface CalibrateStopResponse {
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
