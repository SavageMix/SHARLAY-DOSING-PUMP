import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { __resetSessions as __resetCalibrationSessions } from '../src/calibrator.js';
import { __resetSessions } from '../src/primer.js';
import { createServer } from '../src/server.js';
import { runSteps, runWaveChunk } from '../src/stepper.js';

// Captured at module load, before any fake timers: the real calendar date,
// for the one test that must agree with SQLite's date('now').
const REAL_TODAY = new Date();

describe('Server endpoints', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetSessions();
    __resetCalibrationSessions();
    // Tests that need a dose to stay 'running' mock runSteps as a promise
    // that never settles; without a reset that hang leaks into later tests.
    vi.mocked(runSteps).mockResolvedValue(undefined);
    vi.mocked(runWaveChunk).mockResolvedValue(undefined);
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

  it('a schedule created via POST /api/schedules survives a full server restart', async () => {
    const tmpPath = join(
      tmpdir(),
      `reef-schedule-persist-${process.pid}-${Date.now()}.db`,
    );
    const boot = async () => {
      const db = new ReefDatabase(tmpPath);
      const engine = createEngine(db);
      const server = await createServer(db, engine);
      return { db, server };
    };
    let instance = await boot();
    try {
      const created = await instance.server.fastify.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          pumpId: 'ca',
          volumeMl: 2,
          timesPerDay: 2,
          startTime: '16:00',
          repeatEveryNDays: 1,
          enabled: true,
        },
      });
      expect(created.statusCode).toBe(201);

      // Simulate a reboot: tear everything down, reopen the same DB file.
      await instance.server.close();
      instance.db.close();
      instance = await boot();

      const list = await instance.server.fastify.inject({
        method: 'GET',
        url: '/api/schedules',
      });
      expect(list.statusCode).toBe(200);
      const body = JSON.parse(list.body);
      expect(body.schedules).toHaveLength(1);
      expect(body.schedules[0]).toMatchObject({
        pumpId: 'ca',
        startTime: '16:00',
        timesPerDay: 2,
      });
    } finally {
      await instance.server.close();
      instance.db.close();
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('POST /api/pumps/:id/skip-next refuses when nothing is scheduled', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/pumps/alk/skip-next',
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error).toMatch(
        /no upcoming scheduled dose/i,
      );
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/pumps/:id/skip-next arms the flag, /api/status exposes it, cancel clears it', async () => {
    vi.setSystemTime(new Date('2026-08-23T08:00:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: null,
      });

      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/pumps/alk/skip-next',
      });
      expect(response.statusCode).toBe(200);
      const armBody = JSON.parse(response.body);
      expect(armBody).toMatchObject({ pumpId: 'alk', skipNext: true });
      expect(armBody.skipScheduledFor).toBeTruthy();

      const status = await server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });
      const alk = JSON.parse(status.body).pumps.find(
        (p: { pumpId: string }) => p.pumpId === 'alk',
      );
      expect(alk.skipNext).toBe(true);

      const cancel = await server.fastify.inject({
        method: 'POST',
        url: '/api/pumps/alk/skip-next/cancel',
      });
      expect(cancel.statusCode).toBe(200);
      expect(JSON.parse(cancel.body).skipNext).toBe(false);

      const after = await server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });
      const alkAfter = JSON.parse(after.body).pumps.find(
        (p: { pumpId: string }) => p.pumpId === 'alk',
      );
      expect(alkAfter.skipNext).toBe(false);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('skip-next survives a service restart', async () => {
    const tmpPath = join(
      tmpdir(),
      `reef-skip-next-${process.pid}-${Date.now()}.db`,
    );
    const boot = async () => {
      const db = new ReefDatabase(tmpPath);
      const engine = createEngine(db);
      const server = await createServer(db, engine);
      return { db, server };
    };
    let instance = await boot();
    try {
      instance.db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: null,
      });
      const res = await instance.server.fastify.inject({
        method: 'POST',
        url: '/api/pumps/alk/skip-next',
      });
      expect(res.statusCode).toBe(200);

      // Simulate a reboot: tear everything down, reopen the same DB file.
      await instance.server.close();
      instance.db.close();
      instance = await boot();

      const status = await instance.server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });
      const alk = JSON.parse(status.body).pumps.find(
        (p: { pumpId: string }) => p.pumpId === 'alk',
      );
      expect(alk.skipNext).toBe(true);
    } finally {
      await instance.server.close();
      instance.db.close();
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('skip-next is consumed by the scheduler: no dose fires and history records the skip', async () => {
    vi.setSystemTime(new Date('2026-08-23T08:00:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: null,
      });

      const arm = await server.fastify.inject({
        method: 'POST',
        url: '/api/pumps/alk/skip-next',
      });
      expect(arm.statusCode).toBe(200);

      vi.setSystemTime(new Date('2026-08-23T09:00:30Z'));
      scheduler.tick();

      const status = await server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });
      const pumps = JSON.parse(status.body).pumps;
      const alk = pumps.find((p: { pumpId: string }) => p.pumpId === 'alk');
      expect(alk.skipNext).toBe(false);
      // A skipped dose must not count toward the daily total.
      expect(alk.todayDoseMl).toBe(0);
      expect(JSON.parse(status.body).currentDose).toBeNull();

      const history = await server.fastify.inject({
        method: 'GET',
        url: '/api/history',
      });
      const events = JSON.parse(history.body).events;
      const skipped = events.find(
        (e: { status: string }) => e.status === 'skipped',
      );
      expect(skipped).toMatchObject({
        pumpId: 'alk',
        source: 'schedule',
        requestedMl: 1.5,
        actualMl: null,
      });
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('PATCH /api/schedules/:id updates the startTime and persists across a restart', async () => {
    const tmpPath = join(
      tmpdir(),
      `reef-schedule-patch-${process.pid}-${Date.now()}.db`,
    );
    const boot = async () => {
      const db = new ReefDatabase(tmpPath);
      const engine = createEngine(db);
      const server = await createServer(db, engine);
      return { db, server };
    };
    let instance = await boot();
    try {
      const created = await instance.server.fastify.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          pumpId: 'ca',
          volumeMl: 2,
          timesPerDay: 2,
          startTime: '06:00',
          repeatEveryNDays: 1,
          enabled: true,
        },
      });
      const { schedule } = JSON.parse(created.body);

      // Exact app payload shape (parseForm output, including pumpId).
      const patched = await instance.server.fastify.inject({
        method: 'PATCH',
        url: `/api/schedules/${schedule.id}`,
        payload: {
          pumpId: 'ca',
          volumeMl: 2,
          timesPerDay: 2,
          startTime: '16:00',
          repeatEveryNDays: 1,
          enabled: true,
        },
      });
      expect(patched.statusCode).toBe(200);

      // Reboot and confirm the change stuck.
      await instance.server.close();
      instance.db.close();
      instance = await boot();
      const list = await instance.server.fastify.inject({
        method: 'GET',
        url: '/api/schedules',
      });
      const body = JSON.parse(list.body);
      expect(body.schedules).toHaveLength(1);
      expect(body.schedules[0].startTime).toBe('16:00');
    } finally {
      await instance.server.close();
      instance.db.close();
      await unlink(tmpPath).catch(() => {});
    }
  });

  it('PATCH /api/schedules/:id rejects an invalid startTime with 400 and leaves the row unchanged', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const created = await server.fastify.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          pumpId: 'alk',
          volumeMl: 1,
          timesPerDay: 1,
          startTime: '08:00',
          repeatEveryNDays: 1,
          enabled: true,
        },
      });
      const { schedule } = JSON.parse(created.body);

      const patched = await server.fastify.inject({
        method: 'PATCH',
        url: `/api/schedules/${schedule.id}`,
        payload: { startTime: '25:99' },
      });
      expect(patched.statusCode).toBe(400);

      const list = await server.fastify.inject({ method: 'GET', url: '/api/schedules' });
      const body = JSON.parse(list.body);
      expect(body.schedules[0].startTime).toBe('08:00');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('DELETE /api/schedules/:id removes the schedule', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const created = await server.fastify.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          pumpId: 'no3',
          volumeMl: 0.5,
          timesPerDay: 1,
          startTime: '12:00',
          repeatEveryNDays: 1,
          enabled: true,
        },
      });
      const { schedule } = JSON.parse(created.body);

      const deleted = await server.fastify.inject({
        method: 'DELETE',
        url: `/api/schedules/${schedule.id}`,
      });
      expect(deleted.statusCode).toBe(204);

      const list = await server.fastify.inject({ method: 'GET', url: '/api/schedules' });
      expect(JSON.parse(list.body).schedules).toHaveLength(0);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('DELETE /api/schedules/:id with an explicit JSON content-type but empty body is rejected (client must not do this)', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const created = await server.fastify.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          pumpId: 'no3',
          volumeMl: 0.5,
          timesPerDay: 1,
          startTime: '12:00',
          repeatEveryNDays: 1,
          enabled: true,
        },
      });
      const { schedule } = JSON.parse(created.body);

      const deleted = await server.fastify.inject({
        method: 'DELETE',
        url: `/api/schedules/${schedule.id}`,
        headers: { 'content-type': 'application/json' },
      });
      // Fastify contract: an empty body with a JSON content-type is a 400.
      // The client therefore omits the header on bodyless requests.
      expect(deleted.statusCode).toBe(400);

      const list = await server.fastify.inject({ method: 'GET', url: '/api/schedules' });
      expect(JSON.parse(list.body).schedules).toHaveLength(1);
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

      // Once the engine drains, the entry closes to its terminal state —
      // this is what makes the old re-fire loop impossible.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(db.getMissedDoseById(missedDoses[0].id)?.status).toBe('completed');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/missed-doses/snooze hides pending entries until the horizon', async () => {
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

      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/missed-doses/snooze',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Server computes "now" at request time; allow fake-timer drift.
      expect(body.deferredUntil).toMatch(/^2026-08-24T10:30:00\.\d{3}Z$/);

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      expect(JSON.parse(list.body).missedDoses).toHaveLength(0);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  // Read-only feed for the Catch-ups page RESOLVED section: terminal entries
  // within the window, never pending ones.
  it('GET /api/missed-doses/resolved returns terminal entries from the window only', async () => {
    vi.setSystemTime(new Date('2026-08-24T09:30:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      const mk = (pumpId: 'alk' | 'ca') =>
        db.createSchedule({
          pumpId,
          volumeMl: 1.5,
          timesPerDay: 1,
          startTime: '09:00',
          repeatEveryNDays: 1,
          enabled: true,
          lastRunAt: '2026-08-23T09:00:00.000Z',
        });
      mk('alk');
      mk('ca');
      detectMissedDoses(db, new Date());
      const [alkMiss, caMiss] = db.getPendingMissedDoses(new Date());
      // One skipped (terminal), one still pending, plus an older resolved
      // entry whose scheduled slot is days ago (created_at = now, so it IS
      // inside the window — the window keys on detection time).
      db.updateMissedDoseStatus(alkMiss.id, 'dismissed');
      const old = db.createMissedDose({
        scheduleId: caMiss.scheduleId,
        pumpId: 'no3',
        scheduledFor: '2026-08-20T09:00:00.000Z',
        volumeMl: 1,
        status: 'dismissed',
        deferredUntil: null,
        confirmAfter: null,
      });

      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses/resolved',
      });
      expect(response.statusCode).toBe(200);
      const { missedDoses } = JSON.parse(response.body);
      // Terminal entries only: the dismissed alk and no3 rows, never the
      // still-pending ca one.
      expect(missedDoses).toHaveLength(2);
      const ids = missedDoses.map((m: { id: string }) => m.id);
      expect(ids).toContain(alkMiss.id);
      expect(ids).toContain(old.id);
      expect(ids).not.toContain(caMiss.id);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/missed-doses/dismiss batch-dismisses entries permanently', async () => {
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

      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/missed-doses/dismiss',
        payload: { ids: [missedDoses[0].id] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.dismissed).toEqual([missedDoses[0].id]);
      expect(db.getMissedDoseById(missedDoses[0].id)?.status).toBe('dismissed');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('POST /api/missed-doses/confirm batch-fires selected doses through the engine', async () => {
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
        url: '/api/missed-doses/confirm',
        payload: { ids: [missedDoses[0].id] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.fired).toEqual([missedDoses[0].id]);
      expect(body.scheduled).toEqual([]);
      expect(body.dropped).toEqual([]);

      // The engine closes the entry to its terminal state once the dose
      // physically completes.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(db.getMissedDoseById(missedDoses[0].id)?.status).toBe('completed');
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

  it('POST /api/calibrate/start and /api/calibrate/stop returns steps with stoppedBy user', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      vi.mocked(runWaveChunk).mockImplementation(
        async () => new Promise((resolve) => setTimeout(resolve, 5)),
      );

      const start = await server.fastify.inject({
        method: 'POST',
        url: '/api/calibrate/start',
        payload: { pumpId: 'ca' },
      });
      expect(start.statusCode).toBe(202);

      const stopPromise = server.fastify.inject({
        method: 'POST',
        url: '/api/calibrate/stop',
        payload: { pumpId: 'ca' },
      });
      await vi.advanceTimersByTimeAsync(20);
      const response = await stopPromise;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pumpId).toBe('ca');
      expect(body.totalSteps).toBeGreaterThan(0);
      expect(body.stoppedBy).toBe('user');
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it('reports a watchdog-stopped calibration via /api/status with stoppedBy watchdog', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      vi.mocked(runWaveChunk).mockImplementation(
        async () => new Promise((resolve) => setTimeout(resolve, 5)),
      );

      const start = await server.fastify.inject({
        method: 'POST',
        url: '/api/calibrate/start',
        payload: { pumpId: 'ca' },
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
      expect(body.calibration.calibrating).toBe(false);
      expect(body.calibration.lastResult).toMatchObject({
        pumpId: 'ca',
        stoppedBy: 'watchdog',
        totalSteps: 432_000,
      });

      // The run is over: stopping now is a 409, not an error.
      const lateStop = await server.fastify.inject({
        method: 'POST',
        url: '/api/calibrate/stop',
        payload: { pumpId: 'ca' },
      });
      expect(lateStop.statusCode).toBe(409);
      expect(JSON.parse(lateStop.body).error).toMatch(
        /no calibration running/i,
      );
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

  it('POST /api/dose returns { jobId } matching the running event id in /api/status', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      db.updatePumpCalibration('alk', 100);
      // Keep the dose in the running state so it is visible in /api/status.
      vi.mocked(runSteps).mockImplementation(() => new Promise(() => {}));

      const response = await server.fastify.inject({
        method: 'POST',
        url: '/api/dose',
        payload: { pumpId: 'alk', volumeMl: 1 },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(typeof body.jobId).toBe('string');
      expect(body.event).toBeUndefined();

      const status = await server.fastify.inject({ method: 'GET', url: '/api/status' });
      const statusBody = JSON.parse(status.body);
      expect(statusBody.currentDose?.id).toBe(body.jobId);
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

  it('GET /api/history rejects invalid query params with 400 instead of a silent empty 200', async () => {
    const { db, server, scheduler } = await buildServer();
    try {
      const response = await server.fastify.inject({
        method: 'GET',
        url: '/api/history?days=not-a-number',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');

      const stillWorks = await server.fastify.inject({
        method: 'GET',
        url: '/api/history?days=7',
      });
      expect(stillWorks.statusCode).toBe(200);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  // Bug 1 regression: a confirmed catch-up must fire EXACTLY ONCE and the
  // missed_doses entry must reach a terminal state — not re-fire every tick.
  it('a confirmed catch-up fires exactly once across 2+ hours of scheduler ticks and the entry becomes terminal', async () => {
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
      db.updateSchedule(db.getSchedules()[0].id, { enabled: false });

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      const { missedDoses } = JSON.parse(list.body);
      expect(missedDoses).toHaveLength(1);

      const confirm = await server.fastify.inject({
        method: 'POST',
        url: `/api/missed-doses/${missedDoses[0].id}/confirm`,
      });
      expect(confirm.statusCode).toBe(200);

      // Let the engine drain and simulate 2+ hours of scheduler ticks.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      const history = db.getHistory({});
      const catchups = history.events.filter((e) => e.source === 'catchup');
      expect(catchups).toHaveLength(1);
      expect(catchups[0].missedDoseId).toBe(missedDoses[0].id);

      // The entry is terminal — the re-fire loop is impossible.
      expect(db.getMissedDoseById(missedDoses[0].id)?.status).toBe('completed');

      // Another 2 hours of ticks: still exactly one catch-up dose.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(
        db.getHistory({}).events.filter((e) => e.source === 'catchup'),
      ).toHaveLength(1);
      expect(db.getMissedDoseById(missedDoses[0].id)?.status).toBe('completed');

      // Nothing left pending; history carries the missed slot time.
      const pending = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      expect(JSON.parse(pending.body).missedDoses).toHaveLength(0);

      const apiHistory = await server.fastify.inject({
        method: 'GET',
        url: '/api/history',
      });
      const enriched = JSON.parse(apiHistory.body).events.find(
        (e: { id: string }) => e.id === catchups[0].id,
      );
      expect(enriched.missedDoseScheduledFor).toBe(
        missedDoses[0].scheduledFor,
      );
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  // Bugs 1+2 regression: 8 overnight misses confirmed together fire exactly
  // once each, staggered (per-pump 30 min, global engine gap), and the cap
  // path stays intact.
  it('8 overnight misses confirmed together fire exactly once each, staggered across pumps', async () => {
    vi.setSystemTime(new Date('2026-08-24T01:00:00Z'));
    const { db, server, scheduler } = await buildServer();
    const logSpy = vi.spyOn(console, 'log');
    try {
      db.updatePumpCalibration('alk', 100);
      db.updatePumpCalibration('ca', 100);
      const mk = (pumpId: 'alk' | 'ca') =>
        db.createSchedule({
          pumpId,
          volumeMl: 1.5,
          timesPerDay: 4,
          startTime: '00:00',
          repeatEveryNDays: 1,
          enabled: true,
          lastRunAt: '2026-08-22T00:00:00.000Z',
        });
      mk('alk');
      mk('ca');
      detectMissedDoses(db, new Date());
      for (const s of db.getSchedules()) {
        db.updateSchedule(s.id, { enabled: false });
      }

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      const { missedDoses } = JSON.parse(list.body);
      expect(missedDoses).toHaveLength(8);

      const confirm = await server.fastify.inject({
        method: 'POST',
        url: '/api/missed-doses/confirm',
        payload: { ids: missedDoses.map((m: { id: string }) => m.id) },
      });
      expect(confirm.statusCode).toBe(200);
      const confirmBody = JSON.parse(confirm.body);
      expect(confirmBody.fired).toHaveLength(2); // first of each pump
      expect(confirmBody.scheduled).toHaveLength(6);
      expect(confirmBody.dropped).toHaveLength(0);

      // Queuing must be visible in the log.
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).match(/\[engine\] queued (alk|ca) —/),
        ),
      ).toBe(true);

      // Let the deferred doses fire (per-pump spacing 30 min).
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      const catchups = db
        .getHistory({})
        .events.filter((e) => e.source === 'catchup');
      expect(catchups).toHaveLength(8);

      // Every entry terminal — none can re-fire.
      for (const m of missedDoses) {
        expect(db.getMissedDoseById(m.id)?.status).toBe('completed');
      }

      // Stagger: per-pump gaps >= 30 min (catch-up spacing).
      for (const pumpId of ['alk', 'ca'] as const) {
        const starts = catchups
          .filter((e) => e.pumpId === pumpId)
          .map((e) => new Date(e.startedAt).getTime())
          .sort((a, b) => a - b);
        expect(starts).toHaveLength(4);
        for (let i = 1; i < starts.length; i++) {
          expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(
            30 * 60 * 1000 - 1000,
          );
        }
      }

      // No two pumps overlap: consecutive starts (any pump) respect the
      // engine's inter-dose gap (the shared pump stagger constant).
      const allStarts = catchups
        .map((e) => new Date(e.startedAt).getTime())
        .sort((a, b) => a - b);
      for (let i = 1; i < allStarts.length; i++) {
        expect(allStarts[i] - allStarts[i - 1]).toBeGreaterThanOrEqual(
          90_000 - 500,
        );
      }

      // Two more hours of ticks: exactly-once holds.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(
        db.getHistory({}).events.filter((e) => e.source === 'catchup'),
      ).toHaveLength(8);
    } finally {
      logSpy.mockRestore();
      scheduler.stop();
      db.close();
    }
  });

  // Bug 1 regression: the daily cap is an absolute ceiling re-checked at
  // FIRE time against actually-delivered volume — not just at confirmation.
  // NOTE: this test runs on the REAL wall clock (no setSystemTime) because
  // getTodayDoseMl compares against SQLite date('now').
  it('re-checks the daily cap at fire time and drops a deferred catch-up that no longer fits', async () => {
    // Pin fake time to REAL today at noon so the 2h advance can never cross
    // a midnight boundary — SQLite daily totals use the real date, and prior
    // tests leave the fake clock at arbitrary 2026 dates.
    const midday = new Date(REAL_TODAY);
    midday.setHours(12, 0, 0, 0);
    vi.setSystemTime(midday);
    const { db, server, scheduler } = await buildServer();
    try {
      // 1000 L -> maxSingle 13 mL, maxDaily 65 mL per pump.
      db.setSystemVolumeLitres(1000);
      db.updatePumpCalibration('alk', 100);

      // Hourly slots; the 09:00/10:00/11:00 slots were missed (lastRunAt
      // 08:00). Real-clock anchoring keeps daily-total accounting in SQLite
      // consistent with the fake-timestamped dose events.
      db.createSchedule({
        pumpId: 'alk',
        volumeMl: 10,
        timesPerDay: 24,
        startTime: '00:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: new Date(midday.getTime() - 4 * 60 * 60 * 1000).toISOString(),
      });
      detectMissedDoses(db, new Date());
      db.updateSchedule(db.getSchedules()[0].id, { enabled: false });

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      const { missedDoses } = JSON.parse(list.body);
      expect(missedDoses).toHaveLength(4); // 08:00 (boundary, inclusive) … 11:00

      const confirm = await server.fastify.inject({
        method: 'POST',
        url: '/api/missed-doses/confirm',
        payload: { ids: missedDoses.map((m: { id: string }) => m.id) },
      });
      expect(JSON.parse(confirm.body).fired).toHaveLength(1);

      // Consume the daily headroom with manual doses (13 mL is the max
      // single dose at this volume). First catch-up (10) + 3 x 13 = 49 mL.
      for (let i = 0; i < 3; i++) {
        const dose = await server.fastify.inject({
          method: 'POST',
          url: '/api/dose',
          payload: { pumpId: 'alk', volumeMl: 13 },
        });
        expect(dose.statusCode).toBe(202);
      }

      // By the time the deferred catch-ups come due, today = 49 + 10 = 59 mL.
      // Second catch-up fits (59 <= 65) and fires; every remaining one would
      // exceed the ceiling and must be dropped — never fired.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      const catchups = db
        .getHistory({})
        .events.filter((e) => e.source === 'catchup');
      expect(catchups).toHaveLength(2);

      const statuses = missedDoses.map((m: { id: string }) =>
        db.getMissedDoseById(m.id)?.status,
      );
      expect(statuses.filter((s: string) => s === 'completed')).toHaveLength(2);
      expect(
        statuses.filter((s: string) => s === 'dismissed'),
      ).toHaveLength(missedDoses.length - 2);

      // The dropped ones produced no dose events and never re-fire.
      const firedMissedIds = new Set(
        catchups.map((e) => e.missedDoseId).filter(Boolean),
      );
      for (const m of missedDoses) {
        if (!firedMissedIds.has(m.id)) {
          expect(
            db.getHistory({}).events.some((e) => e.missedDoseId === m.id),
          ).toBe(false);
        }
      }
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(
        db.getHistory({}).events.filter((e) => e.source === 'catchup'),
      ).toHaveLength(2);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  // UX gap regression: after confirming several missed doses, the doses that
  // are not firing yet sit in the engine's stagger queue INVISIBLY — the user
  // thinks they were dropped. /api/status must expose the full catch-up
  // queue (firing + queued, with estimated fire times) so the app's banner
  // can show "3 queued: PO4 ~19:52, …". Page refresh must re-derive the same
  // state because the device is the source of truth.
  it('/api/status exposes the catch-up queue after confirming multiple missed doses', async () => {
    vi.setSystemTime(new Date('2026-08-24T01:00:00Z'));
    const { db, server, scheduler } = await buildServer();
    try {
      const pumps = ['alk', 'ca', 'no3', 'po4'] as const;
      for (const pumpId of pumps) {
        db.updatePumpCalibration(pumpId, 100);
        db.createSchedule({
          pumpId,
          volumeMl: 1.5,
          timesPerDay: 1,
          startTime: '00:00',
          repeatEveryNDays: 1,
          enabled: true,
          lastRunAt: '2026-08-22T00:00:00.000Z',
        });
      }
      detectMissedDoses(db, new Date());
      for (const s of db.getSchedules()) {
        db.updateSchedule(s.id, { enabled: false });
      }

      const list = await server.fastify.inject({
        method: 'GET',
        url: '/api/missed-doses',
      });
      const { missedDoses } = JSON.parse(list.body);
      expect(missedDoses).toHaveLength(4); // one slot per pump

      const confirm = await server.fastify.inject({
        method: 'POST',
        url: '/api/missed-doses/confirm',
        payload: { ids: missedDoses.map((m: { id: string }) => m.id) },
      });
      expect(confirm.statusCode).toBe(200);
      // Four different pumps: every catch-up submits to the engine at once,
      // so the stagger queue is fully populated for the status check.
      expect(JSON.parse(confirm.body).fired).toHaveLength(4);

      const scheduledForById = new Map(
        missedDoses.map((m: { id: string; scheduledFor: string }) => [
          m.id,
          m.scheduledFor,
        ]),
      );
      const confirmTime = Date.now();

      const status = await server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });
      expect(status.statusCode).toBe(200);
      const body = JSON.parse(status.body);

      // Entries whose catch-up already completed are legitimately in NEITHER
      // firing nor queued (instant mocked runSteps can finish dose 1 before
      // this GET). Everything still outstanding must be accounted for across
      // firing + queued — nothing invisible, nothing extra.
      const doneIds = new Set(
        db
          .getHistory({})
          .events.filter(
            (e) => e.source === 'catchup' && e.status === 'completed',
          )
          .map((e) => e.missedDoseId)
          .filter(Boolean),
      );
      const firingId = body.catchupQueue.firing?.missedDoseId ?? null;
      if (firingId !== null) expect(doneIds.has(firingId)).toBe(false);
      const queuedIds = body.catchupQueue.queued.map(
        (q: { missedDoseId: string }) => q.missedDoseId,
      );
      expect(new Set(queuedIds).size).toBe(queuedIds.length);
      for (const id of queuedIds) {
        expect(doneIds.has(id)).toBe(false);
      }
      // Outstanding = confirmed-but-not-completed entries: each is firing,
      // queued, or (if its dose finished before the snapshot) completed.
      for (const m of missedDoses) {
        expect(
          firingId === m.id ||
            queuedIds.includes(m.id) ||
            doneIds.has(m.id),
        ).toBe(true);
      }
      // With one dose done and three staggered behind it, the queue view
      // shows at least the two still waiting in line.
      expect(queuedIds.length).toBeGreaterThanOrEqual(2);
      expect(queuedIds.length + (firingId ? 1 : 0) + doneIds.size).toBe(4);

      // Firing entry, when present, carries the original missed slot time.
      if (body.catchupQueue.firing) {
        expect(body.catchupQueue.firing.missedDoseScheduledFor).toBe(
          scheduledForById.get(body.catchupQueue.firing.missedDoseId),
        );
        expect(pumps).toContain(body.catchupQueue.firing.pumpId);
      }

      // Queued entries: original slot times + estimated fire times spaced by
      // the inter-dose gap (~90s). The first estimate lands about one gap
      // after the confirm; each subsequent one a gap later.
      for (const q of body.catchupQueue.queued) {
        expect(q.missedDoseScheduledFor).toBe(
          scheduledForById.get(q.missedDoseId),
        );
        expect(pumps).toContain(q.pumpId);
      }
      const estTimes = body.catchupQueue.queued.map((q: {
        estimatedFireAt: string;
      }) => new Date(q.estimatedFireAt).getTime());
      expect(estTimes[0] - confirmTime).toBeGreaterThanOrEqual(80_000);
      expect(estTimes[0] - confirmTime).toBeLessThan(120_000);
      for (let i = 1; i < estTimes.length; i++) {
        expect(estTimes[i] - estTimes[i - 1]).toBe(90_000);
      }

      // Let the queue drain: all four fire exactly once and every entry ends
      // terminal — the queue view was describing real, single-fire doses.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const catchups = db
        .getHistory({})
        .events.filter((e) => e.source === 'catchup');
      expect(catchups).toHaveLength(4);
      for (const m of missedDoses) {
        expect(db.getMissedDoseById(m.id)?.status).toBe('completed');
      }

      // Once drained, the queue reports empty.
      const after = await server.fastify.inject({
        method: 'GET',
        url: '/api/status',
      });
      const afterBody = JSON.parse(after.body);
      expect(afterBody.catchupQueue.firing).toBeNull();
      expect(afterBody.catchupQueue.queued).toHaveLength(0);
    } finally {
      scheduler.stop();
      db.close();
    }
  });
});
