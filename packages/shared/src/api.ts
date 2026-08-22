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
  volumeMl: number;
}

export interface CalibrateStartResponse {
  event: DoseEvent;
}

export interface CalibrateStopRequest {
  pumpId: PumpId;
  actualMl: number;
}

export interface CalibrateStopResponse {
  stepsPerMl: number;
}

export interface StatusResponse {
  pumps: PumpState[];
  containers: ContainerInfo[];
  currentDose: DoseEvent | null;
  queue: DoseEvent[];
  systemVolumeLitres: number;
}

export interface LimitsResponse extends ComputedDoseLimits {}

export interface ListSchedulesResponse {
  schedules: DoseSchedule[];
}

export interface CreateScheduleRequest {
  pumpId: PumpId;
  volumeMl: number;
  cron: string;
  enabled?: boolean;
}

export interface CreateScheduleResponse {
  schedule: DoseSchedule;
}

export interface UpdateScheduleRequest {
  volumeMl?: number;
  cron?: string;
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
