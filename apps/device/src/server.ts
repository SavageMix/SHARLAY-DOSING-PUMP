import Fastify from 'fastify';
import { z } from 'zod';
import type { ContainerInfo, PumpState } from '@reef/shared';
import type { ReefDatabase } from './db.js';
import type { Engine } from './engine.js';
import {
  isCalibrating,
  startCalibration,
  stopCalibration,
} from './calibrator.js';

const pumpIdSchema = z.enum(['alk', 'ca', 'no3', 'po4']);

const doseBodySchema = z.object({
  pumpId: pumpIdSchema,
  volumeMl: z.number().positive(),
});

const calibrateStartBodySchema = z.object({
  pumpId: pumpIdSchema,
});

const calibrateStopBodySchema = z.object({
  pumpId: pumpIdSchema,
  measuredMl: z.number().positive(),
});

const scheduleCreateBodySchema = z.object({
  pumpId: pumpIdSchema,
  volumeMl: z.number().positive(),
  cron: z.string().min(1),
  enabled: z.boolean().optional().default(true),
});

const scheduleUpdateBodySchema = z.object({
  pumpId: pumpIdSchema.optional(),
  volumeMl: z.number().positive().optional(),
  cron: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  lastRunAt: z.string().nullable().optional(),
});

const scheduleParamsSchema = z.object({
  id: z.string().uuid(),
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

function firstZodMessage(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? 'Invalid request';
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
      const measured = prompt('Enter measured mL for ' + id + ':');
      if (!measured) return;
      const measuredMl = parseFloat(measured);
      if (!measuredMl || measuredMl <= 0) {
        showMsg(id, 'Invalid measured mL', true);
        return;
      }
      try {
        const res = await postJson('/api/calibrate/stop', { pumpId: id, measuredMl });
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

export function createServer(db: ReefDatabase, engine: Engine) {
  const fastify = Fastify({
    logger: false,
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
    return {
      pumps: buildPumpState(db),
      containers: buildContainerInfo(db),
      currentDose: status.current,
      queue: status.current ? [status.current] : [],
      queueDepth: status.queueDepth,
      systemVolumeLitres: db.getSystemVolumeLitres(),
    };
  });

  fastify.post('/api/dose', async (request, reply) => {
    const body = doseBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: firstZodMessage(body.error) });
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

    if (isCalibrating(body.data.pumpId)) {
      return reply
        .status(409)
        .send({ error: `Calibration already running for ${body.data.pumpId}` });
    }

    startCalibration(body.data.pumpId);
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

    const totalSteps = await stopCalibration(body.data.pumpId);
    const stepsPerMl = totalSteps / body.data.measuredMl;
    db.updatePumpCalibration(body.data.pumpId, stepsPerMl);

    return {
      pumpId: body.data.pumpId,
      stepsPerMl,
    };
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

  return {
    listen: async (port = 8000, host = '0.0.0.0') => {
      await fastify.listen({ port, host });
      console.log(`Reef Doser server listening on http://${host}:${port}`);
    },
    close: async () => {
      await fastify.close();
    },
  };
}
