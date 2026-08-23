import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  CalibrateStartRequest,
  CalibrateStartResponse,
  CalibrateStopRequest,
  CalibrateStopResponse,
  ContainerInfo,
  CreateScheduleRequest,
  CreateScheduleResponse,
  DoseRequest,
  DoseResponse,
  DoseSchedule,
  HistoryResponse,
  LimitsResponse,
  PumpState,
  RefillContainerRequest,
  RefillContainerResponse,
  StatusResponse,
  UpdateScheduleRequest,
  UpdateScheduleResponse,
} from '@reef/shared';

const BASE_URL_KEY = '@reef:deviceBaseUrl';

export async function getDeviceBaseUrl(): Promise<string | null> {
  return AsyncStorage.getItem(BASE_URL_KEY);
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

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
  };
}

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : `HTTP ${response.status}`,
    );
  }

  return data as T;
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

export async function getSchedules(
  baseUrl: string,
): Promise<{ schedules: DoseSchedule[] }> {
  return request<{ schedules: DoseSchedule[] }>(
    baseUrl,
    'GET',
    '/api/schedules',
  );
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

export async function getLimits(
  baseUrl: string,
): Promise<LimitsResponse> {
  return request<LimitsResponse>(baseUrl, 'GET', '/api/limits');
}

export type {
  ContainerInfo,
  DoseSchedule,
  PumpState,
  StatusResponse,
};
