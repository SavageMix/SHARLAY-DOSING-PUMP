import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DoseSchedule } from '@reef/shared';
import {
  createScheduleVerified,
  deleteScheduleVerified,
  updateScheduleVerified,
} from './schedules';

const BASE = 'http://device.test';

const schedule: DoseSchedule = {
  id: '11111111-1111-4111-8111-111111111111',
  pumpId: 'ca',
  volumeMl: 2,
  timesPerDay: 2,
  startTime: '16:00',
  repeatEveryNDays: 1,
  enabled: true,
  lastRunAt: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verified schedule mutations', () => {
  it('happy path: create returns the list containing the new schedule', async () => {
    let schedules: DoseSchedule[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/schedules')) {
        schedules = [...schedules, schedule];
        return jsonResponse(201, { schedule });
      }
      if (url.endsWith('/api/schedules')) return jsonResponse(200, { schedules });
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await createScheduleVerified(BASE, {
      pumpId: 'ca',
      volumeMl: 2,
      timesPerDay: 2,
      startTime: '16:00',
      repeatEveryNDays: 1,
      enabled: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].startTime).toBe('16:00');
  });

  it('server 4xx on create: throws the server error, no phantom entry', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/schedules')) {
        return jsonResponse(400, { error: 'Invalid string: must match pattern' });
      }
      if (url.endsWith('/api/schedules')) return jsonResponse(200, { schedules: [] });
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(
      createScheduleVerified(BASE, {
        pumpId: 'ca',
        volumeMl: 2,
        timesPerDay: 2,
        startTime: '16:0',
        repeatEveryNDays: 1,
        enabled: true,
      }),
    ).rejects.toThrow(/must match pattern/);
  });

  it('create accepted but absent from the next GET: throws, no phantom entry', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/schedules')) {
        return jsonResponse(201, { schedule });
      }
      // The subsequent GET does NOT contain the schedule — e.g. the device
      // is writing to a different database than it serves from.
      if (url.endsWith('/api/schedules')) return jsonResponse(200, { schedules: [] });
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(
      createScheduleVerified(BASE, {
        pumpId: 'ca',
        volumeMl: 2,
        timesPerDay: 2,
        startTime: '16:00',
        repeatEveryNDays: 1,
        enabled: true,
      }),
    ).rejects.toThrow(/not persisted/);
  });

  it('update: throws when the changed field did not stick', async () => {
    const saved: DoseSchedule = { ...schedule, startTime: '06:00' };
    mockFetch((url, init) => {
      if (init?.method === 'PATCH') {
        return jsonResponse(200, { schedule: { ...saved, startTime: '16:00' } });
      }
      if (url.endsWith('/api/schedules')) return jsonResponse(200, { schedules: [saved] });
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(
      updateScheduleVerified(BASE, schedule.id, { startTime: '16:00' }),
    ).rejects.toThrow(/did not save correctly/);
  });

  it('delete: throws when the schedule is still present afterwards', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/api/schedules')) return jsonResponse(200, { schedules: [schedule] });
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(deleteScheduleVerified(BASE, schedule.id)).rejects.toThrow(
      /not deleted/,
    );
  });

  it('happy path: delete returns the list without the schedule', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/api/schedules')) return jsonResponse(200, { schedules: [] });
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await deleteScheduleVerified(BASE, schedule.id);
    expect(result).toHaveLength(0);
  });
});
