import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  AdjustReservoirRequest,
  CalibrateSaveRequest,
  CalibrateSaveResponse,
  CalibrateStartRequest,
  CalibrateStartResponse,
  CalibrateStopRequest,
  CalibrateStopResponse,
  CancelAllMissedDosesResponse,
  CancelDoseResponse,
  CancelMissedDoseResponse,
  ConfirmMissedDoseResponse,
  ConfirmMissedDosesRequest,
  ConfirmMissedDosesResponse,
  ContainerInfo,
  ContainerStatus,
  CreateScheduleRequest,
  CreateScheduleResponse,
  DismissMissedDoseResponse,
  DismissMissedDosesRequest,
  DismissMissedDosesResponse,
  DoseRequest,
  DoseResponse,
  DoseSchedule,
  HistoryResponse,
  LimitsResponse,
  ListContainersResponse,
  ListMissedDosesResponse,
  MissedDose,
  PrimeStartRequest,
  PrimeStartResponse,
  PrimeStopRequest,
  PrimeStopResponse,
  PumpId,
  PumpState,
  RefillContainerRequest,
  RefillContainerResponse,
  RefillReservoirRequest,
  ReservoirResponse,
  SnoozeMissedDosesRequest,
  SnoozeMissedDosesResponse,
  StatusResponse,
  SetSystemVolumeRequest,
  SetSystemVolumeResponse,
  SkipNextDoseResponse,
  UpdateReservoirRequest,
  UpdateScheduleRequest,
  UpdateScheduleResponse,
} from '@reef/shared';

const BASE_URL_KEY = '@reef:deviceBaseUrl';

export const DEFAULT_DEVICE_BASE_URL = 'http://192.168.0.33:8000';

export async function getDeviceBaseUrl(): Promise<string | null> {
  return AsyncStorage.getItem(BASE_URL_KEY);
}

export function resolveDeviceBaseUrl(storedUrl: string | null): string {
  if (typeof window !== 'undefined') {
    const isPiHosted =
      window.location.port === '8000' ||
      window.location.pathname.startsWith('/app');
    if (isPiHosted) {
      return window.location.origin;
    }
  }
  return storedUrl ?? DEFAULT_DEVICE_BASE_URL;
}

export async function setDeviceBaseUrl(url: string): Promise<void> {
  let normalized = url.trim();
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  await AsyncStorage.setItem(BASE_URL_KEY, normalized);
}

export async function clearDeviceBaseUrl(): Promise<void> {
  await AsyncStorage.removeItem(BASE_URL_KEY);
}

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method,
      // Content-Type is only set when there is a JSON body. Sending it on
      // bodyless requests (GET/DELETE) makes Fastify reject the request:
      // "Body cannot be empty when content-type is set to 'application/json'".
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      const message =
        typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
      // Attach the status so callers can classify errors (e.g. a 409
      // "No prime running" means the session already ended, not a failure).
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return data as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getStatus(
  baseUrl: string,
): Promise<StatusResponse> {
  return request<StatusResponse>(baseUrl, 'GET', '/api/status');
}

export async function postDose(
  baseUrl: string,
  body: DoseRequest,
): Promise<DoseResponse> {
  return request<DoseResponse>(baseUrl, 'POST', '/api/dose', body);
}

/**
 * Withdraw a queued manual dose before it fires. 409 when it is already
 * firing or finished — the caller treats that as "refresh state", never as
 * a raw error (same contract as cancelMissedDose).
 */
export async function cancelDose(
  baseUrl: string,
  jobId: string,
): Promise<CancelDoseResponse> {
  return request<CancelDoseResponse>(
    baseUrl,
    'POST',
    `/api/dose/${encodeURIComponent(jobId)}/cancel`,
  );
}

export async function setSystemVolume(
  baseUrl: string,
  body: SetSystemVolumeRequest,
): Promise<SetSystemVolumeResponse> {
  return request<SetSystemVolumeResponse>(
    baseUrl,
    'POST',
    '/api/system/volume',
    body,
  );
}

export async function startCalibration(
  baseUrl: string,
  body: CalibrateStartRequest,
): Promise<CalibrateStartResponse> {
  return request<CalibrateStartResponse>(
    baseUrl,
    'POST',
    '/api/calibrate/start',
    body,
  );
}

export async function stopCalibration(
  baseUrl: string,
  body: CalibrateStopRequest,
): Promise<CalibrateStopResponse> {
  return request<CalibrateStopResponse>(
    baseUrl,
    'POST',
    '/api/calibrate/stop',
    body,
  );
}

export async function startPrime(
  baseUrl: string,
  body: PrimeStartRequest,
): Promise<PrimeStartResponse> {
  return request<PrimeStartResponse>(baseUrl, 'POST', '/api/prime/start', body);
}

export async function stopPrime(
  baseUrl: string,
  body: PrimeStopRequest,
): Promise<PrimeStopResponse> {
  return request<PrimeStopResponse>(baseUrl, 'POST', '/api/prime/stop', body);
}

export async function saveCalibration(
  baseUrl: string,
  body: CalibrateSaveRequest,
): Promise<CalibrateSaveResponse> {
  return request<CalibrateSaveResponse>(
    baseUrl,
    'POST',
    '/api/calibrate/save',
    body,
  );
}

export async function getSchedules(
  baseUrl: string,
): Promise<DoseSchedule[]> {
  const data = await request<{ schedules: DoseSchedule[] }>(
    baseUrl,
    'GET',
    '/api/schedules',
  );
  return data.schedules;
}

export async function createSchedule(
  baseUrl: string,
  body: CreateScheduleRequest,
): Promise<CreateScheduleResponse> {
  return request<CreateScheduleResponse>(baseUrl, 'POST', '/api/schedules', body);
}

export async function updateSchedule(
  baseUrl: string,
  id: string,
  body: UpdateScheduleRequest,
): Promise<UpdateScheduleResponse> {
  return request<UpdateScheduleResponse>(
    baseUrl,
    'PATCH',
    `/api/schedules/${id}`,
    body,
  );
}

export async function deleteSchedule(
  baseUrl: string,
  id: string,
): Promise<void> {
  await request<Record<string, unknown>>(
    baseUrl,
    'DELETE',
    `/api/schedules/${id}`,
  );
}

export async function getHistory(
  baseUrl: string,
  params: { pumpId?: string; days?: number; limit?: number; offset?: number },
): Promise<HistoryResponse> {
  const query = new URLSearchParams();
  if (params.pumpId) query.set('pumpId', params.pumpId);
  if (params.days !== undefined) query.set('days', params.days.toString());
  if (params.limit !== undefined) query.set('limit', params.limit.toString());
  if (params.offset !== undefined) query.set('offset', params.offset.toString());

  const qs = query.toString();
  return request<HistoryResponse>(
    baseUrl,
    'GET',
    `/api/history${qs ? `?${qs}` : ''}`,
  );
}

export async function refillContainer(
  baseUrl: string,
  body: RefillContainerRequest,
): Promise<RefillContainerResponse> {
  return request<RefillContainerResponse>(
    baseUrl,
    'POST',
    '/api/container/refill',
    body,
  );
}

/** Per-pump reservoirs with consumption-derived status (level, low flag, days left). */
export async function getContainers(
  baseUrl: string,
): Promise<ContainerStatus[]> {
  const data = await request<ListContainersResponse>(
    baseUrl,
    'GET',
    '/api/containers',
  );
  return data.containers;
}

/**
 * Reset a reservoir to full (no body) or set it to a partial-refill level.
 * The bodyless call deliberately sends no JSON content-type — Fastify rejects
 * an empty body otherwise (see `request` above).
 */
export async function refillReservoir(
  baseUrl: string,
  pumpId: PumpId,
  body?: RefillReservoirRequest,
): Promise<ReservoirResponse> {
  return request<ReservoirResponse>(
    baseUrl,
    'POST',
    `/api/containers/${pumpId}/refill`,
    body,
  );
}

/** Manual level correction: sets current_ml to exactly `currentMl`. */
export async function adjustReservoir(
  baseUrl: string,
  pumpId: PumpId,
  currentMl: number,
): Promise<ReservoirResponse> {
  return request<ReservoirResponse>(
    baseUrl,
    'POST',
    `/api/containers/${pumpId}/adjust`,
    { currentMl } satisfies AdjustReservoirRequest,
  );
}

/** Edit reservoir settings: display name, capacity, and/or low threshold. */
export async function updateReservoir(
  baseUrl: string,
  pumpId: PumpId,
  body: UpdateReservoirRequest,
): Promise<ReservoirResponse> {
  return request<ReservoirResponse>(
    baseUrl,
    'PATCH',
    `/api/containers/${pumpId}`,
    body,
  );
}

export async function getLimits(
  baseUrl: string,
): Promise<LimitsResponse> {
  return request<LimitsResponse>(baseUrl, 'GET', '/api/limits');
}

export async function getMissedDoses(
  baseUrl: string,
  options: { includeSnoozed?: boolean; includeConfirmed?: boolean } = {},
): Promise<MissedDose[]> {
  const params = new URLSearchParams();
  if (options.includeSnoozed) params.set('includeSnoozed', '1');
  if (options.includeConfirmed) params.set('includeConfirmed', '1');
  const qs = params.toString();
  const data = await request<ListMissedDosesResponse>(
    baseUrl,
    'GET',
    qs ? `/api/missed-doses?${qs}` : '/api/missed-doses',
  );
  return data.missedDoses;
}

/**
 * Terminal missed-dose entries (skipped/expired or whose catch-up finished)
 * detected within the window — feeds the Catch-ups page RESOLVED section.
 */
export async function getResolvedMissedDoses(
  baseUrl: string,
  sinceHours = 24,
): Promise<MissedDose[]> {
  const data = await request<ListMissedDosesResponse>(
    baseUrl,
    'GET',
    `/api/missed-doses/resolved?sinceHours=${sinceHours}`,
  );
  return data.missedDoses;
}

export async function confirmMissedDose(
  baseUrl: string,
  id: string,
): Promise<ConfirmMissedDoseResponse> {
  return request<ConfirmMissedDoseResponse>(
    baseUrl,
    'POST',
    `/api/missed-doses/${id}/confirm`,
  );
}

export async function dismissMissedDose(
  baseUrl: string,
  id: string,
): Promise<DismissMissedDoseResponse> {
  return request<DismissMissedDoseResponse>(
    baseUrl,
    'POST',
    `/api/missed-doses/${id}/dismiss`,
  );
}

export async function snoozeMissedDoses(
  baseUrl: string,
  until?: string,
): Promise<SnoozeMissedDosesResponse> {
  return request<SnoozeMissedDosesResponse>(
    baseUrl,
    'POST',
    '/api/missed-doses/snooze',
    until ? { until } : {},
  );
}

export async function confirmMissedDoses(
  baseUrl: string,
  ids: string[],
): Promise<ConfirmMissedDosesResponse> {
  return request<ConfirmMissedDosesResponse>(
    baseUrl,
    'POST',
    '/api/missed-doses/confirm',
    { ids } satisfies ConfirmMissedDosesRequest,
  );
}

export async function dismissMissedDoses(
  baseUrl: string,
  ids: string[],
): Promise<DismissMissedDosesResponse> {
  return request<DismissMissedDosesResponse>(
    baseUrl,
    'POST',
    '/api/missed-doses/dismiss',
    { ids } satisfies DismissMissedDosesRequest,
  );
}

/**
 * Withdraw one confirmed-but-not-yet-fired catch-up. 409 when it is not
 * confirmed or already firing — the caller treats that as "refresh state",
 * never as a raw error.
 */
export async function cancelMissedDose(
  baseUrl: string,
  id: string,
): Promise<CancelMissedDoseResponse> {
  return request<CancelMissedDoseResponse>(
    baseUrl,
    'POST',
    `/api/missed-doses/${encodeURIComponent(id)}/cancel`,
  );
}

/** Bulk drain escape: withdraw every queued catch-up at once. */
export async function cancelAllMissedDoses(
  baseUrl: string,
): Promise<CancelAllMissedDosesResponse> {
  return request<CancelAllMissedDosesResponse>(
    baseUrl,
    'POST',
    '/api/missed-doses/cancel-all',
  );
}

export async function skipNextDose(
  baseUrl: string,
  pumpId: PumpId,
): Promise<SkipNextDoseResponse> {
  return request<SkipNextDoseResponse>(
    baseUrl,
    'POST',
    `/api/pumps/${pumpId}/skip-next`,
  );
}

export async function cancelSkipNextDose(
  baseUrl: string,
  pumpId: PumpId,
): Promise<SkipNextDoseResponse> {
  return request<SkipNextDoseResponse>(
    baseUrl,
    'POST',
    `/api/pumps/${pumpId}/skip-next/cancel`,
  );
}

export type {
  ContainerInfo,
  ContainerStatus,
  DoseSchedule,
  MissedDose,
  PumpState,
  StatusResponse,
};
