import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { computeDoseLimits, LIMITS } from '@reef/shared';
import type { ContainerInfo, PumpId, PumpState } from '@reef/shared';
import type { ReefDatabase } from './db.js';
import type { Engine } from './engine.js';
import {
  getLastCalibrationResult,
  isCalibrating,
  startCalibration,
  stopCalibration,
} from './calibrator.js';
import {
  confirmMissedDose,
  confirmMissedDoses,
  dismissMissedDose,
  snoozeMissedDoses,
} from './missed-doses.js';
import {
  getLastPrimeResult,
  isPriming,
  setPrimeCompleteHandler,
  startPrime,
  stopPrime,
  type PrimeCompletion,
} from './primer.js';

const pumpIdSchema = z.enum(['alk', 'ca', 'no3', 'po4']);

const doseBodySchema = z.object({
  pumpId: pumpIdSchema,
  volumeMl: z.number().positive(),
});

const calibrateStartBodySchema = z.object({
  pumpId: pumpIdSchema,
  maxSteps: z.number().int().positive().optional(),
});

const calibrateStopBodySchema = z.object({
  pumpId: pumpIdSchema,
});

const calibrateSaveBodySchema = z.object({
  pumpId: pumpIdSchema,
  measuredMl: z.number().positive(),
  totalSteps: z.number().positive(),
});

const primeStartBodySchema = z.object({
  pumpId: pumpIdSchema,
});

const primeStopBodySchema = z.object({
  pumpId: pumpIdSchema,
});

const scheduleCreateBodySchema = z.object({
  pumpId: pumpIdSchema,
  volumeMl: z.number().positive(),
  timesPerDay: z.number().int().min(1).max(24),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  repeatEveryNDays: z.number().int().min(1).max(7),
  enabled: z.boolean().optional().default(true),
});

const scheduleUpdateBodySchema = z.object({
  pumpId: pumpIdSchema.optional(),
  volumeMl: z.number().positive().optional(),
  timesPerDay: z.number().int().min(1).max(24).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  repeatEveryNDays: z.number().int().min(1).max(7).optional(),
  enabled: z.boolean().optional(),
  lastRunAt: z.string().nullable().optional(),
});

const scheduleParamsSchema = z.object({
  id: z.string().uuid(),
});

const missedDoseParamsSchema = z.object({
  id: z.string().uuid(),
});

const snoozeMissedDosesSchema = z.object({
  until: z.string().datetime().optional(),
});

const batchMissedDosesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

const historyQuerySchema = z.object({
  pumpId: pumpIdSchema.optional(),
  days: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional().default(100),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

const refillBodySchema = z.object({
  pumpId: pumpIdSchema,
  containerSizeMl: z.number().positive().optional(),
});

function buildPumpState(db: ReefDatabase): PumpState[] {
  const pumps = db.getAllPumps();
  return pumps.map((pump) => ({
    pumpId: pump.pumpId,
    enabled: true,
    calibrated: pump.stepsPerMl !== null && pump.stepsPerMl > 0,
    stepsPerMl: pump.stepsPerMl,
    todayDoseMl: db.getTodayDoseMl(pump.pumpId),
    containerRemainingMl: pump.containerRemainingMl,
  }));
}

function buildContainerInfo(db: ReefDatabase): ContainerInfo[] {
  return db.getAllPumps().map((pump) => ({
    pumpId: pump.pumpId,
    capacityMl: pump.containerCapacityMl,
    remainingMl: pump.containerRemainingMl,
    lastRefilledAt: null, // could be persisted later
  }));
}

/**
 * Enrich a prime completion with approxMl from the pump's calibration.
 * The primer module is calibration-agnostic by design.
 */
function buildPrimeResult(db: ReefDatabase, result: PrimeCompletion) {
  const calibration = db.getPumpCalibration(result.pumpId);
  const approxMl =
    calibration.stepsPerMl && calibration.stepsPerMl > 0
      ? result.totalSteps / calibration.stepsPerMl
      : null;
  return { ...result, approxMl };
}

function firstZodMessage(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

/**
 * Check if any pump is currently being calibrated.
 */
function isAnyPumpCalibrating(): boolean {
  return (['alk', 'ca', 'no3', 'po4'] as PumpId[]).some((id) =>
    isCalibrating(id),
  );
}

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reef Doser — Test Page</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 1rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f7fa;
      color: #1a202c;
    }
    .banner {
      background: #c53030;
      color: white;
      text-align: center;
      padding: 0.75rem;
      font-size: 1.1rem;
      font-weight: bold;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }
    h1 { font-size: 1.5rem; margin: 0 0 1rem 0; }
    .card {
      background: white;
      border-radius: 0.75rem;
      padding: 1rem;
      margin-bottom: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.75rem;
    }
    .pump-card {
      border: 1px solid #e2e8f0;
      border-radius: 0.5rem;
      padding: 0.75rem;
    }
    .pump-title {
      font-weight: bold;
      font-size: 1.1rem;
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    .metric {
      font-size: 0.9rem;
      color: #4a5568;
      margin-bottom: 0.25rem;
    }
    .row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.5rem;
    }
    button {
      flex: 1;
      padding: 1rem 0.5rem;
      font-size: 1rem;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      min-height: 3rem;
    }
    .btn-green {
      background: #38a169;
      color: white;
      font-weight: bold;
    }
    .btn-red {
      background: #e53e3e;
      color: white;
      font-weight: bold;
    }
    .btn-blue {
      background: #3182ce;
      color: white;
      font-weight: bold;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    input[type="number"] {
      width: 5rem;
      padding: 0.75rem;
      font-size: 1rem;
      border: 1px solid #cbd5e0;
      border-radius: 0.5rem;
    }
    .message {
      margin-top: 0.5rem;
      font-size: 0.85rem;
      color: #2d3748;
      min-height: 1.2rem;
    }
    .error { color: #c53030; }
    .ok { color: #38a169; }
  </style>
</head>
<body>
  <div class="banner">TEST PAGE — LAN ONLY</div>
  <h1>Reef Doser Test</h1>

  <div class="card">
    <div id="status">Loading status...</div>
  </div>

  <div id="pumps" class="status-grid"></div>

  <script>
    const PUMP_IDS = ['alk', 'ca', 'no3', 'po4'];

    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function updateStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const statusEl = document.getElementById('status');
        const queueDepth = data.queueDepth ?? 0;
        const vol = data.systemVolumeLitres ?? '?';
        statusEl.innerHTML = \`
          <div><strong>Queue depth:</strong> \${queueDepth}</div>
          <div><strong>System volume:</strong> \${vol} L</div>
        \`;

        const pumpMap = new Map(data.pumps.map(p => [p.pumpId, p]));
        const containerMap = new Map(data.containers.map(c => [c.pumpId, c]));
        const pumpsEl = document.getElementById('pumps');
        pumpsEl.innerHTML = PUMP_IDS.map(id => {
          const p = pumpMap.get(id) || { calibrated: false, stepsPerMl: null, todayDoseMl: 0 };
          const c = containerMap.get(id) || { remainingMl: 0, capacityMl: 0 };
          return \`
            <div class="pump-card">
              <div class="pump-title">\${id}</div>
              <div class="metric"><strong>Calibrated:</strong> \${p.calibrated ? 'yes' : 'no'}</div>
              <div class="metric"><strong>Steps/mL:</strong> \${p.stepsPerMl ?? '—'}</div>
              <div class="metric"><strong>Container:</strong> \${c.remainingMl.toFixed(1)} / \${c.capacityMl.toFixed(1)} mL</div>
              <div class="metric"><strong>Today:</strong> \${p.todayDoseMl.toFixed(2)} mL</div>
              <div class="row">
                <button class="btn-green" onclick="startCal('\${id}')">START cal</button>
                <button class="btn-red" onclick="stopCal('\${id}')">STOP cal</button>
              </div>
              <div class="row">
                <input type="number" id="dose-\${id}" step="0.1" min="0.1" placeholder="mL">
                <button class="btn-blue" onclick="dose('\${id}')">DOSE</button>
              </div>
              <div id="msg-\${id}" class="message"></div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        document.getElementById('status').innerHTML = '<span class="error">Status fetch failed</span>';
      }
    }

    function showMsg(id, text, isError) {
      const el = document.getElementById('msg-' + id);
      el.textContent = text;
      el.className = 'message ' + (isError ? 'error' : 'ok');
    }

    async function startCal(id) {
      try {
        const res = await postJson('/api/calibrate/start', { pumpId: id });
        const data = await res.json();
        showMsg(id, res.ok ? 'Calibration started' : (data.error || 'Failed'), !res.ok);
      } catch (err) {
        showMsg(id, err.message, true);
      }
      await updateStatus();
    }

    async function stopCal(id) {
      let totalSteps;
      try {
        const res = await postJson('/api/calibrate/stop', { pumpId: id });
        const data = await res.json();
        if (!res.ok) {
          showMsg(id, data.error || 'Failed', true);
          await updateStatus();
          return;
        }
        totalSteps = data.totalSteps;
      } catch (err) {
        showMsg(id, err.message, true);
        return;
      }

      const measured = prompt('Enter measured mL for ' + id + ':');
      if (!measured) return;
      const measuredMl = parseFloat(measured);
      if (!measuredMl || measuredMl <= 0) {
        showMsg(id, 'Invalid measured mL', true);
        return;
      }

      try {
        const res = await postJson('/api/calibrate/save', { pumpId: id, measuredMl, totalSteps });
        const data = await res.json();
        showMsg(id, res.ok ? 'Calibrated: ' + data.stepsPerMl.toFixed(1) + ' steps/mL' : (data.error || 'Failed'), !res.ok);
      } catch (err) {
        showMsg(id, err.message, true);
      }
      await updateStatus();
    }

    async function dose(id) {
      const input = document.getElementById('dose-' + id);
      const volumeMl = parseFloat(input.value);
      if (!volumeMl || volumeMl <= 0) {
        showMsg(id, 'Invalid dose volume', true);
        return;
      }
      try {
        const res = await postJson('/api/dose', { pumpId: id, volumeMl });
        const data = await res.json();
        showMsg(id, res.ok ? 'Job queued: ' + data.jobId : (data.error || 'Failed'), !res.ok);
      } catch (err) {
        showMsg(id, err.message, true);
      }
      await updateStatus();
    }

    window.startCal = startCal;
    window.stopCal = stopCal;
    window.dose = dose;

    updateStatus();
    setInterval(updateStatus, 5000);
  </script>
</body>
</html>`;

export async function createServer(db: ReefDatabase, engine: Engine) {
  const fastify = Fastify({
    logger: false,
  });

  // Audit every completed prime run (user stop or watchdog backstop) as a
  // source 'prime' event. Prime stays excluded from dose totals and history;
  // this handler exists so an unattended watchdog stop is audited too, not
  // only runs stopped via /api/prime/stop.
  setPrimeCompleteHandler((result) => {
    db.saveDoseEvent({
      id: randomUUID(),
      pumpId: result.pumpId,
      requestedMl: 0,
      actualMl: buildPrimeResult(db, result).approxMl,
      status: 'completed',
      source: 'prime',
      scheduleId: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: null,
    });
  });

  // Reflect the request origin. The device is LAN-only, so this lets the
  // Expo web bundle and any local phone browser talk to the Pi without a
  // hard-coded allowed-origin list.
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  // Serve the exported mobile web build at /app. The static files are
  // generated by `npm run export:web -w apps/mobile` into apps/device/public.
  // The plugin registers /app/* but not bare /app, so we add a redirect.
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/app/',
    wildcard: false,
    index: ['index.html'],
  });
  fastify.get('/app', async (_request, reply) => reply.redirect('/app/'));

  // SPA fallback: any unmatched /app path serves the exported per-route HTML
  // file if it exists, otherwise index.html. This lets expo-router handle
  // client-side navigation when a route is loaded directly.
  fastify.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/app')) {
      let rel = pathname.replace(/^\/app\/?/, '').replace(/\/$/, '');
      if (rel) {
        try {
          const info = await stat(join(publicDir, rel));
          if (info.isFile()) {
            return reply.sendFile(rel);
          }
        } catch {}
        try {
          const info = await stat(join(publicDir, `${rel}.html`));
          if (info.isFile()) {
            return reply.sendFile(`${rel}.html`);
          }
        } catch {}
      }
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'Not found' });
  });

  // Catch Fastify validation errors and reply with clean 4xx JSON,
  // never stack traces.
  fastify.setErrorHandler((error, _request, reply) => {
    const fastifyError = error as { statusCode?: number; message: string };
    if (
      fastifyError.statusCode &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      return reply.status(fastifyError.statusCode).send({
        error: fastifyError.message,
      });
    }
    console.error('Server error:', error);
    return reply.status(500).send({
      error: 'Internal server error',
    });
  });

  fastify.get('/', async (_request, reply) => {
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(TEST_PAGE_HTML);
  });

  fastify.get('/api/status', async () => {
    const status = engine.getStatus();
    const primeLast = getLastPrimeResult();
    return {
      pumps: buildPumpState(db),
      containers: buildContainerInfo(db),
      currentDose: status.current,
      queue: status.current ? [status.current] : [],
      queueDepth: status.queueDepth,
      systemVolumeLitres: db.getSystemVolumeLitres(),
      prime: {
        priming: isPriming(),
        lastResult: primeLast ? buildPrimeResult(db, primeLast) : null,
      },
      calibration: {
        calibrating: isAnyPumpCalibrating(),
        lastResult: getLastCalibrationResult(),
      },
    };
  });

  fastify.get('/api/limits', async () => {
    return {
      limits: LIMITS,
      effective: computeDoseLimits(db.getSystemVolumeLitres()),
    };
  });

  fastify.post('/api/dose', async (request, reply) => {
    const body = doseBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (isPriming() || isCalibrating(body.data.pumpId)) {
      return reply.status(409).send({
        error: `Pump ${body.data.pumpId} is busy with another routine`,
      });
    }

    const jobId = await engine.submitDose(
      body.data.pumpId,
      body.data.volumeMl,
      'manual',
    );
    return reply.status(202).send({ jobId });
  });

  fastify.post('/api/calibrate/start', async (request, reply) => {
    const body = calibrateStartBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (engine.getQueueDepth() > 0 || isPriming() || isCalibrating(body.data.pumpId)) {
      return reply
        .status(409)
        .send({ error: `Pump ${body.data.pumpId} is busy with another routine` });
    }

    startCalibration(body.data.pumpId, {
      maxSteps: body.data.maxSteps,
    });
    return reply.status(202).send({ started: true });
  });

  fastify.post('/api/calibrate/stop', async (request, reply) => {
    const body = calibrateStopBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (!isCalibrating(body.data.pumpId)) {
      return reply
        .status(409)
        .send({ error: `No calibration running for ${body.data.pumpId}` });
    }

    const completion = await stopCalibration(body.data.pumpId);
    return completion;
  });

  fastify.post('/api/calibrate/save', async (request, reply) => {
    const body = calibrateSaveBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const stepsPerMl = body.data.totalSteps / body.data.measuredMl;
    db.updatePumpCalibration(body.data.pumpId, stepsPerMl);

    return {
      pumpId: body.data.pumpId,
      stepsPerMl,
    };
  });

  fastify.post('/api/prime/start', async (request, reply) => {
    const body = primeStartBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (engine.getQueueDepth() > 0 || isPriming() || isAnyPumpCalibrating()) {
      return reply.status(409).send({
        error: `Pump ${body.data.pumpId} is busy with another routine`,
      });
    }

    startPrime(body.data.pumpId);
    return reply.status(202).send({ started: true });
  });

  fastify.post('/api/prime/stop', async (request, reply) => {
    const body = primeStopBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (!isPriming(body.data.pumpId)) {
      return reply
        .status(409)
        .send({ error: `No prime running for ${body.data.pumpId}` });
    }

    const completion = await stopPrime(body.data.pumpId);

    // Audit logging happens in the prime complete handler registered at
    // server creation, so watchdog-ended runs are covered too.
    return buildPrimeResult(db, completion);
  });

  fastify.get('/api/schedules', async () => {
    return { schedules: db.getSchedules() };
  });

  fastify.post('/api/schedules', async (request, reply) => {
    const body = scheduleCreateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const schedule = db.createSchedule({
      ...body.data,
      lastRunAt: null,
    });
    return reply.status(201).send({ schedule });
  });

  fastify.patch('/api/schedules/:id', async (request, reply) => {
    const params = scheduleParamsSchema.safeParse(request.params);
    const body = scheduleUpdateBodySchema.safeParse(request.body);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    const schedule = db.updateSchedule(params.data.id, body.data);
    return { schedule };
  });

  fastify.delete('/api/schedules/:id', async (request, reply) => {
    const params = scheduleParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    db.deleteSchedule(params.data.id);
    return reply.status(204).send();
  });

  fastify.get('/api/history', async (request) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return { events: [], total: 0 };
    }

    return db.getHistory({
      pumpId: query.data.pumpId,
      days: query.data.days,
      limit: query.data.limit,
      offset: query.data.offset,
    });
  });

  fastify.post('/api/container/refill', async (request, reply) => {
    const body = refillBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }

    if (body.data.containerSizeMl !== undefined) {
      db.setContainerCapacity(body.data.pumpId, body.data.containerSizeMl);
    }
    db.refillContainer(body.data.pumpId);

    const remaining = db.getContainerRemainingMl(body.data.pumpId);
    const capacity =
      db.getAllPumps().find((p) => p.pumpId === body.data.pumpId)
        ?.containerCapacityMl ?? 0;

    return {
      pumpId: body.data.pumpId,
      remainingMl: remaining,
      capacityMl: capacity,
    };
  });

  fastify.get('/api/missed-doses', async () => {
    return { missedDoses: db.getPendingMissedDoses(new Date()) };
  });

  fastify.post('/api/missed-doses/snooze', async (request, reply) => {
    const body = snoozeMissedDosesSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }
    const deferredUntil = snoozeMissedDoses(
      db,
      new Date(),
      body.data.until ? new Date(body.data.until) : undefined,
    );
    return { deferredUntil };
  });

  fastify.post('/api/missed-doses/confirm', async (request, reply) => {
    const body = batchMissedDosesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }
    try {
      return await confirmMissedDoses(db, engine, body.data.ids, new Date());
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Failed to confirm',
      });
    }
  });

  fastify.post('/api/missed-doses/dismiss', async (request, reply) => {
    const body = batchMissedDosesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
    }
    try {
      const dismissed = body.data.ids.map((id) => {
        dismissMissedDose(db, id);
        return id;
      });
      return { dismissed };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Failed to dismiss',
      });
    }
  });

  fastify.post('/api/missed-doses/:id/confirm', async (request, reply) => {
    const params = missedDoseParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    try {
      const jobId = await confirmMissedDose(db, engine, params.data.id);
      const missedDose = db.getMissedDoseById(params.data.id);
      return { missedDose, jobId };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Failed to confirm',
      });
    }
  });

  fastify.post('/api/missed-doses/:id/dismiss', async (request, reply) => {
    const params = missedDoseParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: firstZodMessage(params.error) });
    }

    try {
      dismissMissedDose(db, params.data.id);
      const missedDose = db.getMissedDoseById(params.data.id);
      return { missedDose };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Failed to dismiss',
      });
    }
  });

  return {
    fastify,
    listen: async (port = 8000, host = '0.0.0.0') => {
      await fastify.listen({ port, host });
      console.log(`Reef Doser server listening on http://${host}:${port}`);
    },
    close: async () => {
      await fastify.close();
    },
  };
}
