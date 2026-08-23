import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

  it('migrates an old cron-based schedules table without touching dose_events or pumps', () => {
    const tmpPath = path.join(os.tmpdir(), `reef-migration-test-${Date.now()}.db`);

    try {
      // Create a database with the legacy schema and some data.
      const raw = new Database(tmpPath);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS pumps (
          pump_id TEXT PRIMARY KEY,
          steps_per_ml REAL,
          container_capacity_ml REAL NOT NULL,
          container_remaining_ml REAL NOT NULL
        );
        INSERT INTO pumps (pump_id, steps_per_ml, container_capacity_ml, container_remaining_ml)
        VALUES ('alk', 42.5, 1000, 950);

        CREATE TABLE IF NOT EXISTS schedules (
          id TEXT PRIMARY KEY,
          pump_id TEXT NOT NULL,
          volume_ml REAL NOT NULL,
          cron TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          last_run_at TEXT
        );
        INSERT INTO schedules (id, pump_id, volume_ml, cron, enabled, last_run_at)
        VALUES ('sched-1', 'alk', 1.5, '0 9 * * *', 1, NULL);

        CREATE TABLE IF NOT EXISTS dose_events (
          id TEXT PRIMARY KEY,
          pump_id TEXT NOT NULL,
          requested_ml REAL NOT NULL,
          actual_ml REAL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          schedule_id TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error TEXT
        );
        INSERT INTO dose_events (id, pump_id, requested_ml, actual_ml, status, source, schedule_id, started_at, finished_at, error)
        VALUES ('event-1', 'alk', 1.5, 1.5, 'completed', 'schedule', 'sched-1', '2026-08-23T09:00:00.000Z', '2026-08-23T09:00:05.000Z', NULL);
      `);
      raw.close();

      // Wrap it with ReefDatabase to trigger migration.
      const db = new ReefDatabase(tmpPath);

      try {
        // Pumps and calibration preserved.
        const pumps = db.getAllPumps();
        expect(pumps).toHaveLength(1); // existing pump row preserved, not re-seeded
        const alk = pumps.find((p) => p.pumpId === 'alk');
        expect(alk?.stepsPerMl).toBe(42.5);

        // Old schedules table was dropped and recreated; existing schedules are gone.
        expect(db.getSchedules()).toEqual([]);

        // Dose events still exist.
        const history = db.getHistory({});
        expect(history.total).toBe(1);
        expect(history.events[0].id).toBe('event-1');
      } finally {
        db.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
