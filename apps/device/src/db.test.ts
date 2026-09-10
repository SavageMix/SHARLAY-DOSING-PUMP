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
        missedDoseId: null,
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

  it('migrates a real pre-snooze database (no deferred_until/confirm_after) without bricking boot', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-pre-snooze-migration-test-${Date.now()}.db`,
    );

    try {
      // Recreate a database exactly as an older build left it on a customer's
      // Pi: missed_doses WITHOUT deferred_until/confirm_after, with the two
      // original indexes and a pending row. The current (broken) initSchema
      // crash-loops on this file with "no such column: confirm_after".
      const raw = new Database(tmpPath);
      raw.exec(`
        CREATE TABLE missed_doses (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          pump_id TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          volume_ml REAL NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_missed_doses_status ON missed_doses(status);
        CREATE INDEX idx_missed_doses_schedule_for
          ON missed_doses(schedule_id, scheduled_for);
        INSERT INTO missed_doses (id, schedule_id, pump_id, scheduled_for, volume_ml, status, created_at)
        VALUES ('missed-1', 'sched-1', 'alk', '2026-09-01T09:00:00.000Z', 1.5, 'pending', '2026-09-01T09:30:00.000Z');
      `);
      raw.close();

      // This constructor is the boot-time crash site: it must migrate, not throw.
      const db = new ReefDatabase(tmpPath);

      try {
        // Existing row preserved and visible.
        const pending = db.getPendingMissedDoses(new Date('2026-09-01T10:00:00Z'));
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          id: 'missed-1',
          pumpId: 'alk',
          volumeMl: 1.5,
          status: 'pending',
          deferredUntil: null,
          confirmAfter: null,
        });

        // Migrated columns are live: snooze hides, then the horizon passes.
        db.snoozePendingMissedDoses('2026-09-01T11:00:00.000Z');
        expect(
          db.getPendingMissedDoses(new Date('2026-09-01T10:30:00Z')),
        ).toHaveLength(0);
        expect(
          db.getPendingMissedDoses(new Date('2026-09-01T11:01:00Z')),
        ).toHaveLength(1);
      } finally {
        db.close();
      }

      // Post-migration schema on disk: both columns and the new index exist.
      const check = new Database(tmpPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const columns = (
          check
            .prepare("SELECT name FROM pragma_table_info('missed_doses')")
            .all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(columns).toContain('deferred_until');
        expect(columns).toContain('confirm_after');

        const indexes = (
          check
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'missed_doses'",
            )
            .all() as Array<{ name: string }>
        ).map((i) => i.name);
        expect(indexes).toContain('idx_missed_doses_confirm_after');
      } finally {
        check.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('marks dose events left running by a killed process as interrupted on boot', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-interrupted-test-${Date.now()}.db`,
    );

    try {
      // First boot: a scheduled dose starts, then the process "dies" mid-dose
      // (the pump physically stops, but nothing closes the event).
      const db = new ReefDatabase(tmpPath);
      db.saveDoseEvent({
        id: 'event-1',
        pumpId: 'no3',
        requestedMl: 2,
        actualMl: 0.4, // partially delivered before the kill
        status: 'running',
        source: 'schedule',
        scheduleId: 'sched-1',
        missedDoseId: null,
        startedAt: '2026-09-08T08:00:00.000Z',
        finishedAt: null,
        error: null,
      });
      db.saveDoseEvent({
        id: 'event-2',
        pumpId: 'ca',
        requestedMl: 1,
        actualMl: null,
        status: 'queued',
        source: 'manual',
        scheduleId: null,
        missedDoseId: null,
        startedAt: '2026-09-08T08:01:00.000Z',
        finishedAt: null,
        error: null,
      });
      db.close();

      // Reboot: the constructor must close the stale events as 'interrupted'.
      const reopened = new ReefDatabase(tmpPath);
      try {
        const history = reopened.getHistory({});
        const interrupted = history.events.filter(
          (e) => e.status === 'interrupted',
        );
        expect(interrupted).toHaveLength(2);
        expect(interrupted.find((e) => e.id === 'event-1')).toMatchObject({
          pumpId: 'no3',
          actualMl: 0.4, // partial delivery stays visible for the record
        });

        // An interrupted dose under-delivered: it must NOT count toward
        // today's total as if it completed.
        expect(reopened.getTodayDoseMl('no3')).toBe(0);
        expect(reopened.getTodayDoseMl('ca')).toBe(0);
      } finally {
        reopened.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('recovers a half-migrated database (deferred_until present, confirm_after missing)', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-half-migrated-test-${Date.now()}.db`,
    );

    try {
      // Simulate a migration interrupted mid-way (e.g. power cut during boot).
      const raw = new Database(tmpPath);
      raw.exec(`
        CREATE TABLE missed_doses (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          pump_id TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          volume_ml REAL NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          deferred_until TEXT
        );
      `);
      raw.close();

      const db = new ReefDatabase(tmpPath);
      db.close();

      const check = new Database(tmpPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const columns = (
          check
            .prepare("SELECT name FROM pragma_table_info('missed_doses')")
            .all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(columns).toContain('deferred_until');
        expect(columns).toContain('confirm_after');
      } finally {
        check.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('migrates a pre-catch-up database (dose_events without missed_dose_id) without bricking boot', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-pre-catchup-test-${Date.now()}.db`,
    );

    try {
      // Old-schema database: dose_events predates the missed_dose_id column.
      const raw = new Database(tmpPath);
      raw.exec(`
        CREATE TABLE dose_events (
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
        INSERT INTO dose_events
          (id, pump_id, requested_ml, actual_ml, status, source, schedule_id, started_at, finished_at, error)
        VALUES
          ('event-old', 'alk', 1.5, 1.5, 'completed', 'schedule', 'sched-1', '2026-08-23T09:00:00.000Z', '2026-08-23T09:00:05.000Z', NULL);
      `);
      raw.close();

      const db = new ReefDatabase(tmpPath);
      try {
        // Old rows survive with a null link; new writes populate the column.
        const history = db.getHistory({});
        expect(history.events).toHaveLength(1);
        expect(history.events[0].missedDoseId).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('finalizeDoseEvent closes the missed entry atomically with the dose event', () => {
    const db = new ReefDatabase(':memory:');

    try {
      const schedule = db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1.5,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: null,
      });
      const missed = db.createMissedDose({
        scheduleId: schedule.id,
        pumpId: 'alk',
        scheduledFor: '2026-08-23T09:00:00.000Z',
        volumeMl: 1.5,
        status: 'confirmed',
        deferredUntil: null,
        confirmAfter: null,
      });

      db.finalizeDoseEvent({
        id: 'catchup-1',
        pumpId: 'alk',
        requestedMl: 1.5,
        actualMl: 1.5,
        status: 'completed',
        source: 'catchup',
        scheduleId: schedule.id,
        missedDoseId: missed.id,
        startedAt: '2026-08-23T10:00:00.000Z',
        finishedAt: '2026-08-23T10:00:30.000Z',
        error: null,
      });

      expect(db.getMissedDoseById(missed.id)?.status).toBe('completed');
      const event = db.getHistory({}).events.find((e) => e.id === 'catchup-1');
      expect(event).toMatchObject({
        source: 'catchup',
        missedDoseId: missed.id,
        status: 'completed',
      });
    } finally {
      db.close();
    }
  });

  it('finalizeDoseEvent maps failed and interrupted catch-ups to terminal entry states', () => {
    const db = new ReefDatabase(':memory:');

    try {
      const makeConfirmed = (scheduledFor: string) =>
        db.createMissedDose({
          scheduleId: 'sched-1',
          pumpId: 'alk',
          scheduledFor,
          volumeMl: 1,
          status: 'confirmed',
          deferredUntil: null,
          confirmAfter: null,
        });

      const failed = makeConfirmed('2026-08-23T06:00:00.000Z');
      db.finalizeDoseEvent({
        id: 'catchup-failed',
        pumpId: 'alk',
        requestedMl: 1,
        actualMl: null,
        status: 'failed',
        source: 'catchup',
        scheduleId: 'sched-1',
        missedDoseId: failed.id,
        startedAt: '2026-08-23T10:00:00.000Z',
        finishedAt: '2026-08-23T10:00:01.000Z',
        error: 'Pump alk is not calibrated',
      });
      expect(db.getMissedDoseById(failed.id)?.status).toBe('failed');

      const interrupted = makeConfirmed('2026-08-23T07:00:00.000Z');
      db.finalizeDoseEvent({
        id: 'catchup-interrupted',
        pumpId: 'alk',
        requestedMl: 1,
        actualMl: null,
        status: 'interrupted',
        source: 'catchup',
        scheduleId: 'sched-1',
        missedDoseId: interrupted.id,
        startedAt: '2026-08-23T10:00:00.000Z',
        finishedAt: null,
        error: null,
      });
      expect(db.getMissedDoseById(interrupted.id)?.status).toBe('interrupted');
    } finally {
      db.close();
    }
  });

  it('boot reconciliation: confirmed entry with a terminal catch-up event is closed to match it', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-reconcile-confirmed-${Date.now()}.db`,
    );

    try {
      // Previous boot: a catch-up fired and the event was finalized...
      const db = new ReefDatabase(tmpPath);
      const missed = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-08-23T09:00:00.000Z',
        volumeMl: 1.5,
        status: 'confirmed',
        deferredUntil: null,
        confirmAfter: null,
      });
      db.saveDoseEvent({
        id: 'catchup-1',
        pumpId: 'alk',
        requestedMl: 1.5,
        actualMl: 1.5,
        status: 'completed',
        source: 'catchup',
        scheduleId: 'sched-1',
        missedDoseId: missed.id,
        startedAt: '2026-08-23T10:00:00.000Z',
        finishedAt: '2026-08-23T10:00:30.000Z',
        error: null,
      });
      // ...but the entry update never landed (simulated crash between writes).
      db.updateMissedDoseStatus(missed.id, 'confirmed');
      db.close();

      // Next boot: reconciliation closes it from the event — never re-fires.
      const reopened = new ReefDatabase(tmpPath);
      try {
        expect(reopened.getMissedDoseById(missed.id)?.status).toBe('completed');
      } finally {
        reopened.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('boot reconciliation: confirmed entry with NO dose event is reset to pending, not re-fired', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-reconcile-suspicious-${Date.now()}.db`,
    );

    try {
      // Previous boot: entry confirmed, dose submitted, process died before
      // any event was persisted.
      const db = new ReefDatabase(tmpPath);
      const missed = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'no3',
        scheduledFor: '2026-08-23T09:00:00.000Z',
        volumeMl: 2,
        status: 'pending',
        deferredUntil: null,
        confirmAfter: null,
      });
      db.updateMissedDoseStatus(missed.id, 'confirmed');
      db.setMissedDoseConfirmAfter(missed.id, '2026-08-23T09:30:00.000Z');
      db.close();

      // Next boot: the entry must NOT be eligible to fire; it goes back to
      // the user for a fresh decision.
      const reopened = new ReefDatabase(tmpPath);
      try {
        const entry = reopened.getMissedDoseById(missed.id);
        expect(entry?.status).toBe('pending');
        expect(entry?.confirmAfter).toBeNull();
        expect(
          reopened.getDueScheduledConfirmations(new Date('2026-08-23T12:00:00Z')),
        ).toHaveLength(0);
      } finally {
        reopened.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
