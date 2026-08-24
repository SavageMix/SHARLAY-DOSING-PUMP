import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@reef/shared';
import { ReefDatabase } from '../src/db.js';
import { createEngine } from '../src/engine.js';

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

import { createServer } from '../src/server.js';

describe('Server endpoints', () => {
  async function buildServer() {
    const db = new ReefDatabase(':memory:');
    const engine = createEngine(db);
    const server = await createServer(db, engine);
    return { db, server };
  }

  it('GET /api/limits returns static LIMITS and effective volume-based caps', async () => {
    const { db, server } = await buildServer();
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
      db.close();
    }
  });

  it('GET /api/limits reflects a changed system volume', async () => {
    const { db, server } = await buildServer();
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
      db.close();
    }
  });

  it('includes CORS headers reflecting the request origin', async () => {
    const { db, server } = await buildServer();
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
      db.close();
    }
  });
});
