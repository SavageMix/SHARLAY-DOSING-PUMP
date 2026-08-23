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
