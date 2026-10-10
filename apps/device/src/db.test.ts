import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { DoseEvent, PumpId } from '@reef/shared';
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
          error: 'Power lost during dose — unknown volume delivered',
        });
        // Closed at boot: the true finish instant is unknowable, so the
        // event must not sit with a null finishedAt forever.
        expect(
          interrupted.every((e) => e.finishedAt != null),
        ).toBe(true);
        expect(interrupted.find((e) => e.id === 'event-2')?.error).toBe(
          'Power lost before dose started — dose never ran',
        );

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

  it('recordCancelledDoseEvent inserts a cancelled row on an empty table', () => {
    const db = new ReefDatabase(':memory:');

    try {
      const event: DoseEvent = {
        id: 'cancel-1',
        pumpId: 'ca',
        requestedMl: 2,
        actualMl: null,
        status: 'cancelled',
        source: 'manual',
        scheduleId: null,
        missedDoseId: null,
        startedAt: '2026-08-23T10:00:00.000Z',
        finishedAt: '2026-08-23T10:00:00.000Z',
        error: 'Cancelled by user before it fired',
      };

      expect(db.recordCancelledDoseEvent(event)).toBe(true);

      const saved = db.getDoseEventById('cancel-1');
      expect(saved).toEqual(event);
    } finally {
      db.close();
    }
  });

  it('recordCancelledDoseEvent loses to a pre-existing row: a started dose is never rewritten as cancelled', () => {
    const db = new ReefDatabase(':memory:');

    try {
      // The engine persisted the 'running' event before the dose fired; the
      // cancel write lost the race. INSERT OR IGNORE must drop it.
      const started: DoseEvent = {
        id: 'job-1',
        pumpId: 'no3',
        requestedMl: 2,
        actualMl: null,
        status: 'running',
        source: 'manual',
        scheduleId: null,
        missedDoseId: null,
        startedAt: '2026-08-23T10:00:00.000Z',
        finishedAt: null,
        error: null,
      };
      db.saveDoseEvent(started);

      const losingWrite: DoseEvent = {
        ...started,
        status: 'cancelled',
        finishedAt: '2026-08-23T10:00:01.000Z',
        error: 'Cancelled by user before it fired',
      };
      expect(db.recordCancelledDoseEvent(losingWrite)).toBe(false);

      // The true outcome stands, every field byte-for-byte.
      expect(db.getDoseEventById('job-1')).toEqual(started);
    } finally {
      db.close();
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

      // The reservoir deduction is part of the SAME transaction: the entry
      // closed and the level dropped together or not at all.
      const container = db.getContainers().find((c) => c.pumpId === 'alk');
      expect(container?.currentMl).toBeCloseTo(998.5, 10);
      expect(db.getContainerRemainingMl('alk')).toBeCloseTo(998.5, 10);
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

  it('kill -9 mid-drain: fired catch-ups close, the in-flight dose is interrupted, unfired entries revert to pending — nothing auto-fires', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-kill-mid-drain-${Date.now()}.db`,
    );

    try {
      // Live drain: three catch-ups confirmed. The first fired and
      // finalized; the second was physically mid-dose when the process was
      // killed (running event, partially delivered); the third was queued
      // behind it, never started. All three entries still say 'confirmed'.
      const db = new ReefDatabase(tmpPath);
      const fired = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-08-23T06:00:00.000Z',
        volumeMl: 1,
        status: 'confirmed',
        deferredUntil: null,
        confirmAfter: null,
      });
      const midFlight = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-08-23T07:00:00.000Z',
        volumeMl: 1,
        status: 'confirmed',
        deferredUntil: null,
        confirmAfter: null,
      });
      const unfired = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-08-23T08:00:00.000Z',
        volumeMl: 1,
        status: 'confirmed',
        deferredUntil: null,
        confirmAfter: '2026-08-23T08:30:00.000Z',
      });
      db.saveDoseEvent({
        id: 'ev-fired',
        pumpId: 'alk',
        requestedMl: 1,
        actualMl: 1,
        status: 'completed',
        source: 'catchup',
        scheduleId: 'sched-1',
        missedDoseId: fired.id,
        startedAt: '2026-08-23T06:00:10.000Z',
        finishedAt: '2026-08-23T06:00:40.000Z',
        error: null,
      });
      db.saveDoseEvent({
        id: 'ev-midflight',
        pumpId: 'alk',
        requestedMl: 1,
        actualMl: 0.3,
        status: 'running',
        source: 'catchup',
        scheduleId: 'sched-1',
        missedDoseId: midFlight.id,
        startedAt: '2026-08-23T07:00:05.000Z',
        finishedAt: null,
        error: null,
      });
      db.close(); // the "kill" — no clean shutdown ran

      // Boot: reconciliation, not the engine, owns recovery. Nothing may
      // auto-fire; every entry reaches a state the user can reason about.
      const reopened = new ReefDatabase(tmpPath);
      try {
        // Fired pre-kill: closed from its completed event.
        expect(reopened.getMissedDoseById(fired.id)?.status).toBe('completed');
        // Mid-flight at the kill: the event is interrupted with an honest
        // note, and the entry is interrupted too (it under-delivered — the
        // owner decides what to do, the system never re-fires it).
        const midEvent = reopened
          .getHistory({})
          .events.find((e) => e.id === 'ev-midflight');
        expect(midEvent?.status).toBe('interrupted');
        expect(midEvent?.error).toBe(
          'Power lost during dose — unknown volume delivered',
        );
        expect(
          reopened.getMissedDoseById(midFlight.id)?.status,
        ).toBe('interrupted');
        // Unfired: the decision goes back to the user — never re-queued.
        const unfiredEntry = reopened.getMissedDoseById(unfired.id);
        expect(unfiredEntry?.status).toBe('pending');
        expect(unfiredEntry?.confirmAfter).toBeNull();

        // No auto-fire: no new events appeared and nothing is due.
        expect(reopened.getHistory({}).events).toHaveLength(2);
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


describe('containers (reservoir tracking)', () => {
  function doseEvent(partial: Partial<DoseEvent> & { id: string }): DoseEvent {
    const now = new Date().toISOString();
    return {
      pumpId: 'alk',
      requestedMl: 10,
      actualMl: 10,
      status: 'completed',
      source: 'manual',
      scheduleId: null,
      missedDoseId: null,
      startedAt: now,
      finishedAt: now,
      error: null,
      ...partial,
    };
  }

  function containerOf(db: ReefDatabase, pumpId: PumpId) {
    const container = db.getContainers().find((c) => c.pumpId === pumpId);
    expect(container).toBeDefined();
    return container!;
  }

  it('seeds four named reservoirs full on a fresh database', () => {
    const db = new ReefDatabase(':memory:');

    try {
      const containers = db.getContainers();
      expect(containers.map((c) => c.pumpId).sort()).toEqual([
        'alk',
        'ca',
        'no3',
        'po4',
      ]);
      const alk = containerOf(db, 'alk');
      expect(alk).toMatchObject({
        name: 'Alkalinity',
        capacityMl: 1000,
        currentMl: 1000,
        lowThresholdMl: 100,
        low: false,
        daysRemaining: null,
      });
      expect(typeof alk.updatedAt).toBe('string');
    } finally {
      db.close();
    }
  });

  it('seeds an honest level from existing dose history on first run', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-container-seed-${Date.now()}.db`,
    );

    try {
      // A database that already has dosing history: 80 mL of completed
      // reservoir doses, plus prime/calibration/failed liquid that must NOT
      // count against the reservoir.
      const raw = new Database(tmpPath);
      raw.exec(`
        CREATE TABLE pumps (
          pump_id TEXT PRIMARY KEY,
          steps_per_ml REAL,
          container_capacity_ml REAL NOT NULL,
          container_remaining_ml REAL NOT NULL
        );
        INSERT INTO pumps (pump_id, steps_per_ml, container_capacity_ml, container_remaining_ml)
        VALUES ('alk', NULL, 1000, 950), ('ca', NULL, 1000, 1000),
               ('no3', NULL, 1000, 1000), ('po4', NULL, 1000, 1000);

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
          ('ev-manual', 'alk', 50, 50, 'completed', 'manual', NULL, '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:10.000Z', NULL),
          ('ev-sched', 'alk', 30, 30, 'completed', 'schedule', 'sched-1', '2026-08-02T09:00:00.000Z', '2026-08-02T09:00:10.000Z', NULL),
          ('ev-prime', 'alk', 0, 500, 'completed', 'prime', NULL, '2026-08-03T09:00:00.000Z', '2026-08-03T00:01:00.000Z', NULL),
          ('ev-cal', 'alk', 0, 40, 'completed', 'calibration', NULL, '2026-08-04T09:00:00.000Z', '2026-08-04T00:01:00.000Z', NULL),
          ('ev-failed', 'alk', 25, NULL, 'failed', 'manual', NULL, '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:02.000Z', 'stepper fault');
      `);
      raw.close();

      const db = new ReefDatabase(tmpPath);

      try {
        expect(containerOf(db, 'alk').currentMl).toBe(920);
        // Pumps without history start full.
        expect(containerOf(db, 'ca').currentMl).toBe(1000);
      } finally {
        db.close();
      }
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('deducts on completed doses only — never on failed/interrupted/skipped/cancelled', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.finalizeDoseEvent(
        doseEvent({ id: 'ev-completed', pumpId: 'alk', requestedMl: 10, actualMl: 9.5 }),
      );
      expect(containerOf(db, 'alk').currentMl).toBeCloseTo(990.5, 10);
      expect(db.getContainerRemainingMl('alk')).toBeCloseTo(990.5, 10);

      for (const [pumpId, status] of [
        ['ca', 'failed'],
        ['no3', 'interrupted'],
        ['po4', 'skipped'],
        ['alk', 'cancelled'],
      ] as Array<[PumpId, DoseEvent['status']]>) {
        db.finalizeDoseEvent(
          doseEvent({
            id: `ev-${status}`,
            pumpId,
            status,
            actualMl: null,
            error: status,
          }),
        );
      }

      expect(containerOf(db, 'ca').currentMl).toBe(1000);
      expect(containerOf(db, 'no3').currentMl).toBe(1000);
      expect(containerOf(db, 'po4').currentMl).toBe(1000);
      // The cancelled alk dose moved nothing either: still 990.5.
      expect(containerOf(db, 'alk').currentMl).toBeCloseTo(990.5, 10);
    } finally {
      db.close();
    }
  });

  it('never deducts for prime or calibration completions', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.finalizeDoseEvent(
        doseEvent({
          id: 'ev-prime',
          pumpId: 'alk',
          requestedMl: 0,
          actualMl: 300,
          source: 'prime',
        }),
      );
      db.finalizeDoseEvent(
        doseEvent({
          id: 'ev-cal',
          pumpId: 'ca',
          requestedMl: 0,
          actualMl: 40,
          source: 'calibration',
        }),
      );

      expect(containerOf(db, 'alk').currentMl).toBe(1000);
      expect(containerOf(db, 'ca').currentMl).toBe(1000);
    } finally {
      db.close();
    }
  });

  it('clamps the level at zero when a dose exceeds the remaining volume', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.adjustReservoirLevel('alk', 5);
      db.finalizeDoseEvent(
        doseEvent({ id: 'ev-big', pumpId: 'alk', requestedMl: 10, actualMl: 10 }),
      );

      expect(containerOf(db, 'alk').currentMl).toBe(0);
      expect(db.getContainerRemainingMl('alk')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('daysRemaining extrapolates the 14-day average and ignores prime volume', () => {
    const db = new ReefDatabase(':memory:');

    try {
      // 140 mL of completed reservoir doses inside the window → 10 mL/day.
      for (let i = 0; i < 14; i++) {
        const startedAt = new Date(
          Date.now() - i * 24 * 60 * 60 * 1000,
        ).toISOString();
        db.saveDoseEvent(
          doseEvent({
            id: `ev-day-${i}`,
            pumpId: 'alk',
            requestedMl: 10,
            actualMl: 10,
            startedAt,
            finishedAt: startedAt,
          }),
        );
      }
      // Prime volume inside the window must not inflate consumption.
      db.saveDoseEvent(
        doseEvent({
          id: 'ev-prime',
          pumpId: 'alk',
          requestedMl: 0,
          actualMl: 500,
          source: 'prime',
        }),
      );

      db.adjustReservoirLevel('alk', 100);
      expect(containerOf(db, 'alk').daysRemaining).toBe(10);

      db.adjustReservoirLevel('alk', 95);
      expect(containerOf(db, 'alk').daysRemaining).toBe(9.5);
    } finally {
      db.close();
    }
  });

  it('daysRemaining is null with no consumption history', () => {
    const db = new ReefDatabase(':memory:');

    try {
      expect(containerOf(db, 'alk').daysRemaining).toBeNull();

      // Only prime history exists: still null.
      db.saveDoseEvent(
        doseEvent({
          id: 'ev-prime',
          pumpId: 'alk',
          requestedMl: 0,
          actualMl: 500,
          source: 'prime',
        }),
      );
      expect(containerOf(db, 'alk').daysRemaining).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refill resets to capacity; partial refill sets the level, clamped', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.adjustReservoirLevel('alk', 400);
      db.refillReservoir('alk');
      expect(containerOf(db, 'alk').currentMl).toBe(1000);
      expect(db.getContainerRemainingMl('alk')).toBe(1000);

      db.refillReservoir('alk', 400);
      expect(containerOf(db, 'alk').currentMl).toBe(400);

      db.refillReservoir('alk', 5000);
      expect(containerOf(db, 'alk').currentMl).toBe(1000);
      expect(db.getContainerRemainingMl('alk')).toBe(1000);
    } finally {
      db.close();
    }
  });

  it('adjust sets the level clamped to [0, capacity] and mirrors legacy', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.adjustReservoirLevel('alk', 250);
      expect(containerOf(db, 'alk').currentMl).toBe(250);
      expect(db.getContainerRemainingMl('alk')).toBe(250);

      db.adjustReservoirLevel('alk', -10);
      expect(containerOf(db, 'alk').currentMl).toBe(0);
      expect(db.getContainerRemainingMl('alk')).toBe(0);

      db.adjustReservoirLevel('alk', 10_000);
      expect(containerOf(db, 'alk').currentMl).toBe(1000);
    } finally {
      db.close();
    }
  });

  it('low is true exactly at the threshold, false above it', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.adjustReservoirLevel('alk', 100.1);
      expect(containerOf(db, 'alk').low).toBe(false);

      db.adjustReservoirLevel('alk', 100);
      expect(containerOf(db, 'alk').low).toBe(true);

      db.adjustReservoirLevel('alk', 0);
      expect(containerOf(db, 'alk').low).toBe(true);
    } finally {
      db.close();
    }
  });

  it('updateReservoir edits settings and clamps a capacity shrink', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.adjustReservoirLevel('alk', 500);
      db.updateReservoir('alk', {
        name: 'Kalkwasser',
        capacityMl: 300,
        lowThresholdMl: 50,
      });

      const alk = containerOf(db, 'alk');
      expect(alk.name).toBe('Kalkwasser');
      expect(alk.capacityMl).toBe(300);
      expect(alk.currentMl).toBe(300); // clamped to the new capacity
      expect(alk.lowThresholdMl).toBe(50);

      // Legacy column mirrored.
      const legacy = db.getAllPumps().find((p) => p.pumpId === 'alk');
      expect(legacy?.containerCapacityMl).toBe(300);
      expect(legacy?.containerRemainingMl).toBe(300);
    } finally {
      db.close();
    }
  });

  it('updateReservoir throws Unknown pump for an unseeded pump', () => {
    const db = new ReefDatabase(':memory:');

    try {
      expect(() =>
        db.updateReservoir('nope' as PumpId, { name: 'X' }),
      ).toThrow(/Unknown pump nope/);
      expect(() => db.refillReservoir('nope' as PumpId)).toThrow(
        /Unknown pump nope/,
      );
      expect(() => db.adjustReservoirLevel('nope' as PumpId, 100)).toThrow(
        /Unknown pump nope/,
      );
    } finally {
      db.close();
    }
  });

  it('legacy refillContainer mirrors into containers in both directions', () => {
    const db = new ReefDatabase(':memory:');

    try {
      db.adjustReservoirLevel('alk', 400);
      db.refillContainer('alk', 100); // legacy ADDS
      expect(containerOf(db, 'alk').currentMl).toBe(500);
      expect(db.getContainerRemainingMl('alk')).toBe(500);

      db.refillContainer('alk'); // legacy tops up
      expect(containerOf(db, 'alk').currentMl).toBe(1000);

      // And the new refillReservoir mirrors back into the legacy column.
      db.refillReservoir('alk', 600);
      expect(db.getContainerRemainingMl('alk')).toBe(600);
    } finally {
      db.close();
    }
  });
});
