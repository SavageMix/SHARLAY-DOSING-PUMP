import { describe, expect, it } from 'vitest';
import { ReefDatabase } from '../src/db.js';

describe('ReefDatabase smoke', () => {
  it('opens an in-memory database and seeds four pumps', () => {
    const db = new ReefDatabase(':memory:');

    try {
      const pumps = db.getAllPumps();
      expect(pumps).toHaveLength(4);
      expect(pumps.map((p) => p.pumpId).sort()).toEqual([
        'alk',
        'ca',
        'no3',
        'po4',
      ]);

      for (const pump of pumps) {
        expect(pump.stepsPerMl).toBeNull();
        expect(pump.containerCapacityMl).toBe(1000);
        expect(pump.containerRemainingMl).toBe(1000);
      }

      expect(db.getSystemVolumeLitres()).toBe(380);
    } finally {
      db.close();
    }
  });

  it('persists a dose event and returns it in history', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.saveDoseEvent({
        id: 'event-1',
        pumpId: 'alk',
        requestedMl: 2.5,
        actualMl: 2.5,
        status: 'completed',
        source: 'manual',
        scheduleId: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: null,
      });

      const history = db.getHistory({ pumpId: 'alk' });
      expect(history.total).toBe(1);
      expect(history.events[0].id).toBe('event-1');
    } finally {
      db.close();
    }
  });
});
