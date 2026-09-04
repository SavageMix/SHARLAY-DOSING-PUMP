import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  createSchedule,
  deleteSchedule,
  getHistory,
  getMissedDoses,
  getSchedules,
  getStatus,
} from './client';

const BASE = 'http://device.test';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

let captured: CapturedRequest | null = null;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  captured = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured = {
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string> | undefined,
        body: init?.body as string | undefined,
      };
      return jsonResponse(200, {});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request headers', () => {
  it('DELETE sends no Content-Type header and no body', async () => {
    await deleteSchedule(BASE, '11111111-1111-4111-8111-111111111111');
    expect(captured!.method).toBe('DELETE');
    expect(captured!.headers).toBeUndefined();
    expect(captured!.body).toBeUndefined();
  });

  it('GET sends no Content-Type header', async () => {
    await getStatus(BASE);
    expect(captured!.headers).toBeUndefined();

    await getSchedules(BASE);
    expect(captured!.headers).toBeUndefined();

    await getMissedDoses(BASE);
    expect(captured!.headers).toBeUndefined();

    await getHistory(BASE, { days: 30 });
    expect(captured!.headers).toBeUndefined();
  });

  it('POST with a body sends Content-Type: application/json', async () => {
    await createSchedule(BASE, {
      pumpId: 'ca',
      volumeMl: 2,
      timesPerDay: 2,
      startTime: '16:00',
      repeatEveryNDays: 1,
      enabled: true,
    });
    expect(captured!.method).toBe('POST');
    expect(captured!.headers?.['Content-Type']).toBe('application/json');
    expect(captured!.body).toBeDefined();
  });
});
