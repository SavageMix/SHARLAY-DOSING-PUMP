import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@reef/shared';
import { ReefDatabase } from '../src/db.js';
import { createEngine } from '../src/engine.js';
import { createScheduler } from '../src/scheduler.js';

vi.mock('../src/gpio.js', () => ({
  driversDisable: vi.fn(),
  driversEnable: vi.fn(),
  GPIO_PINS: {},
  stepPins: {},
  dirPin: {},
  configurePins: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('../src/stepper.js', () => ({
  runSteps: vi.fn(),
  runWaveChunk: vi.fn(),
  MAX_STEPS_PER_WAVE: 1000,
}));

import { detectMissedDoses } from '../src/missed-doses.js';
import { __resetSessions } from '../src/primer.js';
import { createServer } from '../src/server.js';
import { runSteps, runWaveChunk } from '../src/stepper.js';

describe('Server endpoints', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetSessions();
  });
  async function buildServer() {
    const db = new ReefDatabase(':memory:');
    const engine = createEngine(db);
    const scheduler = createScheduler(db, engine);
    const server = await createServer(db, engine);
    scheduler.start();
    return { db, server, scheduler };
  }

  it('GET /api/limits returns static LIMITS and effective volume-based caps', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/limits',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.limits).toEqual(LIMITS);
      expect(body.effective.systemVolumeLitres).toBe(380);
      expect(body.effective.maxSingleDoseMl).toBeCloseTo(4.94, 10);
      expect(body.effective.maxDailyDoseMlPerPump).toBeCloseTo(24.7, 10);
      expect(body.effective.rates).toBeDefined();
      expect(body.effective.hardLimits).toBeDefined();
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('GET /api/limits reflects a changed system volume', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      db.setSystemVolumeLitres(200);

      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/limits',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.effective.systemVolumeLitres).toBe(200);
      expect(body.effective.maxSingleDoseMl).toBe(2.6);
      expect(body.effective.maxDailyDoseMlPerPump).toBe(13);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('GET /api/missed-doses lists pending missed doses', async () => {
    vi.setSystemTime(new Date('2026-08-24T09:30:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      const schedule = db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: '2026-08-23T09:00:00.000Z',
      });
      detectMissedDoses(db, new Date());

      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.missedDoses).toHaveLength(1);
      expect(body.missedDoses[0]).toMatchObject({
        scheduleId: schedule.id,
        pumpId: 'alk',
        volumeMl: 1.5,
        status: 'pending',
      });
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/missed-doses/:id/dismiss marks a missed dose dismissed', async () => {
    vi.setSystemTime(new Date('2026-08-24T09:30:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: '2026-08-23T09:00:00.000Z',
      });
      detectMissedDoses(db, new Date());

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      const { missedDoses } = JSON.parse(list.body);
      expect(missedDoses).toHaveLength(1);

      const response = await server.fastify.inject({
        method: 'POST',
        url: `/api/missed-doses/${missedDoses[0].id}/dismiss`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.missedDose.status).toBe('dismissed');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/missed-doses/:id/confirm queues the missed dose through the engine', async () => {
    vi.setSystemTime(new Date('2026-08-24T09:30:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      db.updatePumpCalibration('alk', 100);
      db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: '2026-08-23T09:00:00.000Z',
      });
      detectMissedDoses(db, new Date());

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      const { missedDoses } = JSON.parse(list.body);

      const response = await server.fastify.inject({
        method: 'POST',
        url: `/api/missed-doses/${missedDoses[0].id}/confirm`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.missedDose.status).toBe('confirmed');
      expect(body.jobId).toBeDefined();
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/prime/start and /api/prime/stop returns steps and null approxMl on an uncalibrated pump', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      vi.mocked(runWaveChunk).mockImplementation(
        async () => new Promise((resolve) => setTimeout(resolve, 5)),
      );

      const start = await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/start',
        payload: { pumpId: 'alk' },
      });
      expect(start.statusCode).toBe(202);

      const stopPromise = server.fastify.inject({
        method: 'POST',
        url: '/api/prime/stop',
        payload: { pumpId: 'alk' },
      });
      await vi.advanceTimersByTimeAsync(20);
      const response = await stopPromise;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pumpId).toBe('alk');
      expect(body.totalSteps).toBeGreaterThan(0);
      expect(body.approxMl).toBeNull();
      expect(body.stoppedBy).toBe('user');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/prime/stop returns approxMl when the pump is calibrated', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      db.updatePumpCalibration('alk', 100);
      vi.mocked(runWaveChunk).mockImplementation(
        async () => new Promise((resolve) => setTimeout(resolve, 5)),
      );

      await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/start',
        payload: { pumpId: 'alk' },
      });

      const stopPromise = server.fastify.inject({
        method: 'POST',
        url: '/api/prime/stop',
        payload: { pumpId: 'alk' },
      });
      await vi.advanceTimersByTimeAsync(20);
      const response = await stopPromise;

      const body = JSON.parse(response.body);
      expect(body.approxMl).not.toBeNull();
      expect(body.totalSteps / body.approxMl).toBeCloseTo(100, 5);
      expect(body.stoppedBy).toBe('user');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('reports a watchdog-stopped prime via /api/status with stoppedBy watchdog', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      db.updatePumpCalibration('alk', 100);
      vi.mocked(runWaveChunk).mockImplementation(
        async () => new Promise((resolve) => setTimeout(resolve, 5)),
      );

      const start = await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/start',
        payload: { pumpId: 'alk' },
      });
      expect(start.statusCode).toBe(202);

      // Let the default 540 s backstop elapse under fake timers
      // (432 chunks x 5 ms), ending the run via the watchdog.
      await vi.advanceTimersByTimeAsync(2500);

      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.prime.priming).toBe(false);
      expect(body.prime.lastResult).toMatchObject({
        pumpId: 'alk',
        stoppedBy: 'watchdog',
        totalSteps: 432_000,
      });
      expect(body.prime.lastResult.approxMl).toBeCloseTo(4320, 5);

      // The run is over: stopping now is a 409, not an error dose.
      const lateStop = await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/stop',
        payload: { pumpId: 'alk' },
      });
      expect(lateStop.statusCode).toBe(409);

      // Watchdog-stopped runs stay out of dose totals and history.
      expect(db.getTodayDoseMl('alk')).toBe(0);
      expect(db.getHistory().events).toHaveLength(0);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('Prime does not count toward daily dose totals or appear in history', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      db.updatePumpCalibration('alk', 100);
      vi.mocked(runWaveChunk).mockImplementation(
        async () => new Promise((resolve) => setTimeout(resolve, 5)),
      );

      await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/start',
        payload: { pumpId: 'alk' },
      });

      const stopPromise = server.fastify.inject({
        method: 'POST',
        url: '/api/prime/stop',
        payload: { pumpId: 'alk' },
      });
      await vi.advanceTimersByTimeAsync(20);
      await stopPromise;

      expect(db.getTodayDoseMl('alk')).toBe(0);

      const history = db.getHistory();
      expect(history.events).toHaveLength(0);
      expect(history.total).toBe(0);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/dose is refused while priming', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      // Make runWaveChunk hang so the prime session stays active.
      vi.mocked(runWaveChunk).mockImplementation(
        () => new Promise(() => {}),
      );

      await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/start',
        payload: { pumpId: 'alk' },
      });

      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/dose',
        payload: { pumpId: 'alk', volumeMl: 1 },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toMatch(/busy/i);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/prime/start is refused while a dose is running', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      db.updatePumpCalibration('alk', 100);
      // Make runSteps hang so the dose stays in the running state.
      vi.mocked(runSteps).mockImplementation(() => new Promise(() => {}));

      await server.fastify.inject({
        method: 'POST',
        url: '/api/dose',
        payload: { pumpId: 'alk', volumeMl: 1 },
      });

      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/prime/start',
        payload: { pumpId: 'alk' },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toMatch(/busy/i);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('includes CORS headers reflecting the request origin', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/limits',
        headers: { origin: 'http://192.168.0.123:8081' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://192.168.0.123:8081',
      );
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('serves the mobile web bundle at /app without affecting /api routes', async () => {
    const indexPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
    await writeFile(
      indexPath,
      '<!DOCTYPE html><html><body>SHARLAY Web</body></html>',
      'utf-8',
    );

    const { db, server, scheduler } = await buildServer();
    try {
      const redirectResponse = await server.fastify.inject({
        method: 'GET',
        url: '/app',
      });
      expect(redirectResponse.statusCode).toBe(302);
      expect(redirectResponse.headers.location).toBe('/app/');

      const appResponse = await server.fastify.inject({
        method: 'GET',
        url: '/app/',
      });
      expect(appResponse.statusCode).toBe(200);
      expect(appResponse.body).toContain('SHARLAY Web');
      expect(appResponse.headers['content-type']).toContain('text/html');

      const apiResponse = await server.fastify.inject({
        method: 'GET',
        url: '/api/limits',
      });
      expect(apiResponse.statusCode).toBe(200);
    } finally {
      scheduler.stop();
      db.close();
      await unlink(indexPath);
    }
  });

  it('falls back to index.html for unmatched /app routes so client routing works', async () => {
    const publicDir = fileURLToPath(new URL('../public', import.meta.url));
    const indexPath = join(publicDir, 'index.html');
    const settingsPath = join(publicDir, 'settings.html');
    const assetPath = join(publicDir, 'spa-asset.txt');
    await writeFile(indexPath, '<html>SHARLAY index</html>', 'utf-8');
    await writeFile(settingsPath, '<html>SHARLAY settings</html>', 'utf-8');
    await writeFile(assetPath, 'real file', 'utf-8');

    const { db, server, scheduler } = await buildServer();
    try {
      const settingsResponse = await server.fastify.inject({
        method: 'GET',
        url: '/app/settings',
      });
      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.body).toContain('SHARLAY settings');
      expect(settingsResponse.headers['content-type']).toContain('text/html');

      const assetResponse = await server.fastify.inject({
        method: 'GET',
        url: '/app/spa-asset.txt',
      });
      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.body).toBe('real file');
      expect(assetResponse.headers['content-type']).toContain('text/plain');

      const fallbackResponse = await server.fastify.inject({
        method: 'GET',
        url: '/app/this-route-does-not-exist',
      });
      expect(fallbackResponse.statusCode).toBe(200);
      expect(fallbackResponse.body).toContain('SHARLAY index');
      expect(fallbackResponse.headers['content-type']).toContain('text/html');

      const apiResponse = await server.fastify.inject({
        method: 'GET',
        url: '/api/nonexistent-endpoint',
      });
      expect(apiResponse.statusCode).toBe(404);
      expect(JSON.parse(apiResponse.body)).toHaveProperty('error');
    } finally {
      scheduler.stop();
      db.close();
      await unlink(indexPath);
      await unlink(settingsPath);
      await unlink(assetPath);
    }
  });
});
