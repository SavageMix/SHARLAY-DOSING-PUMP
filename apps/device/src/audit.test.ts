import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { DoseEvent } from '@reef/shared';
import { ReefDatabase } from '../src/db.js';
import {
  createAuditStore,
  runIntegrityAudit,
  type AuditResult,
} from '../src/audit.js';

// Wall-clock slots are computed device-locally; pin UTC so the fixtures below
// are deterministic (same convention as scheduler.test.ts).
process.env.TZ = 'UTC';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function event(partial: Partial<DoseEvent> & { id: string }): DoseEvent {
  return {
    pumpId: 'alk',
    requestedMl: 1.5,
    actualMl: 1.5,
    status: 'completed',
    source: 'manual',
    scheduleId: null,
    missedDoseId: null,
    startedAt: '2026-09-12T06:01:00.000Z',
    finishedAt: '2026-09-12T06:02:00.000Z',
    error: null,
    ...partial,
  };
}

/** A daily 06:00 alk schedule whose lastRunAt anchors slot enumeration. */
function seedSchedule(db: ReefDatabase, lastRunAt: string | null) {
  return db.createSchedule({
    pumpId: 'alk',
    volumeMl: 1.5,
    timesPerDay: 1,
    startTime: '06:00',
    repeatEveryNDays: 1,
    enabled: true,
    lastRunAt,
  });
}

function auditDb(db: ReefDatabase, now: Date = NOW): AuditResult {
  return runIntegrityAudit(db.createAuditStore(), now);
}

function rmQuietly(filePath: string): void {
  // Windows can hold the sqlite file handle briefly after close — retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(filePath, { force: true });
      return;
    } catch {
      // keep trying briefly
    }
  }
  fs.rmSync(filePath, { force: true });
}

describe('boot-time integrity audit', () => {
  it('healthy record: quiet pass, no findings', () => {
    const db = new ReefDatabase(':memory:');
    try {
      // A fully-resolved catch-up: completed missed row + exactly one linked
      // event, plus an unrelated manual event.
      const missed = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'po4',
        scheduledFor: '2026-09-11T06:00:00.000Z',
        volumeMl: 1,
        status: 'completed',
        deferredUntil: null,
        confirmAfter: null,
      });
      db.saveDoseEvent(
        event({
          id: 'ev-catchup',
          source: 'catchup',
          pumpId: 'po4',
          missedDoseId: missed.id,
        }),
      );
      db.saveDoseEvent(event({ id: 'ev-manual' }));

      const result = auditDb(db);
      expect(result.findings).toEqual([]);
      // 2 missed rows? No — 1 missed row + 2 events = 3 records, no enabled
      // schedules so no slots were scanned.
      expect(result.verified).toBe(3);
    } finally {
      db.close();
    }
  });

  it('completed missed row with no dose event is a phantom completion', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const missed = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-09-11T06:00:00.000Z',
        volumeMl: 1.5,
        status: 'completed',
        deferredUntil: null,
        confirmAfter: null,
      });

      const result = auditDb(db);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        check: 'completed-without-event',
        pumpId: 'alk',
        missedSlotIso: '2026-09-11T06:00:00.000Z',
      });
      expect(result.findings[0].id).toBe(`completed-without-event:${missed.id}`);
      expect(result.findings[0].message).toContain('ALK');
      expect(result.findings[0].message).toContain('no dose event');
    } finally {
      db.close();
    }
  });

  it('completed missed row with several linked events is reported', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const missed = db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'ca',
        scheduledFor: '2026-09-11T06:00:00.000Z',
        volumeMl: 2,
        status: 'completed',
        deferredUntil: null,
        confirmAfter: null,
      });
      db.saveDoseEvent(
        event({ id: 'ev-1', source: 'catchup', pumpId: 'ca', missedDoseId: missed.id }),
      );
      db.saveDoseEvent(
        event({ id: 'ev-2', source: 'catchup', pumpId: 'ca', missedDoseId: missed.id }),
      );

      const result = auditDb(db);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].check).toBe('completed-without-event');
      expect(result.findings[0].message).toContain('2 dose events');
    } finally {
      db.close();
    }
  });

  it('catch-up event with a dangling or missing missed-dose link is an orphan', () => {
    const db = new ReefDatabase(':memory:');
    try {
      db.saveDoseEvent(
        event({ id: 'ev-dangling', source: 'catchup', missedDoseId: 'gone' }),
      );
      db.saveDoseEvent(
        event({ id: 'ev-unlinked', source: 'catchup', missedDoseId: null }),
      );

      const result = auditDb(db);
      expect(result.findings).toHaveLength(2);
      expect(result.findings.map((f) => f.check)).toEqual([
        'orphan-catchup-event',
        'orphan-catchup-event',
      ]);
      expect(result.findings[0].message).toContain('no longer exists');
      expect(result.findings[1].message).toContain('no missed-dose record linked');
    } finally {
      db.close();
    }
  });

  it('a past slot with neither an event nor a missed entry is unresolved', () => {
    const db = new ReefDatabase(':memory:');
    try {
      // lastRunAt 30h ago → the 06:00 slot today is due and inside the 24h
      // lookback, with no resolution of any kind.
      seedSchedule(db, '2026-09-11T06:00:00.000Z');

      const result = auditDb(db);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        check: 'unresolved-slot',
        pumpId: 'alk',
        missedSlotIso: '2026-09-12T06:00:00.000Z',
      });
      expect(result.findings[0].message).toContain('never fired');
    } finally {
      db.close();
    }
  });

  it('a slot resolved by a handled event is not flagged', () => {
    const db = new ReefDatabase(':memory:');
    try {
      seedSchedule(db, '2026-09-11T06:00:00.000Z');
      db.saveDoseEvent(
        event({
          id: 'ev-fired',
          source: 'schedule',
          scheduleId: db.getEnabledSchedules()[0].id,
          startedAt: '2026-09-12T06:01:30.000Z', // slot + pump stagger
        }),
      );

      expect(auditDb(db).findings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a slot resolved by a dismissed missed entry is not flagged', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const schedule = seedSchedule(db, '2026-09-11T06:00:00.000Z');
      db.createMissedDose({
        scheduleId: schedule.id,
        pumpId: 'alk',
        scheduledFor: '2026-09-12T06:00:00.000Z',
        volumeMl: 1.5,
        status: 'dismissed',
        deferredUntil: null,
        confirmAfter: null,
      });

      expect(auditDb(db).findings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('slots older than the lookback are forgotten by design and not flagged', () => {
    const db = new ReefDatabase(':memory:');
    try {
      // lastRunAt 3 days ago: yesterday's and today's 06:00 slots are due but
      // only today's is inside the 24h lookback... actually yesterday 06:00 is
      // 30h before NOW — outside. So only today's slot is audited and it is
      // unresolved. Plant a resolution for today's to isolate the old one.
      seedSchedule(db, '2026-09-09T06:00:00.000Z');
      const schedule = db.getEnabledSchedules()[0];
      db.createMissedDose({
        scheduleId: schedule.id,
        pumpId: 'alk',
        scheduledFor: '2026-09-12T06:00:00.000Z',
        volumeMl: 1.5,
        status: 'expired',
        deferredUntil: null,
        confirmAfter: null,
      });

      // Yesterday's 06:00 slot (30h old) has no resolution and must NOT be
      // flagged — detection deliberately forgets it.
      expect(auditDb(db).findings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a confirmed row surviving boot reconciliation is stuck-confirmed', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-audit-confirmed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      // Plant via raw SQL: a confirmed missed row whose linked event is in a
      // NON-terminal status that is not running/queued — the one combination
      // boot reconciliation deliberately leaves untouched (unknown future
      // status), so it survives to the audit.
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
          deferred_until TEXT,
          confirm_after TEXT
        );
        CREATE TABLE dose_events (
          id TEXT PRIMARY KEY,
          pump_id TEXT NOT NULL,
          requested_ml REAL NOT NULL,
          actual_ml REAL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          schedule_id TEXT,
          missed_dose_id TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error TEXT
        );
        INSERT INTO missed_doses VALUES (
          'md-stuck', 'sched-1', 'no3',
          '2026-09-11T06:00:00.000Z', 1.5, 'confirmed',
          '2026-09-11T06:05:00.000Z', NULL, NULL
        );
        INSERT INTO dose_events VALUES (
          'ev-weird', 'no3', 1.5, NULL, 'custom-status', 'catchup',
          'sched-1', 'md-stuck',
          '2026-09-11T06:06:00.000Z', NULL, NULL
        );
      `);
      raw.close();

      // Opening through ReefDatabase runs the real boot reconciliation.
      const db = new ReefDatabase(tmpPath);
      try {
        const result = auditDb(db);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
          check: 'stuck-confirmed',
          pumpId: 'no3',
          missedSlotIso: '2026-09-11T06:00:00.000Z',
        });
        expect(result.findings[0].message).toContain('still marked confirmed');
      } finally {
        db.close();
      }
    } finally {
      rmQuietly(tmpPath);
    }
  });

  it('a confirmed row reset to pending by reconciliation is NOT flagged', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-audit-reset-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      // Plant confirmed-with-no-event BEFORE the database opens, so the
      // constructor's boot reconciliation processes it (it must hand the
      // decision back to 'pending') before the audit ever runs.
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
          deferred_until TEXT,
          confirm_after TEXT
        );
        INSERT INTO missed_doses VALUES (
          'md-reset', 'sched-1', 'alk',
          '2026-09-11T06:00:00.000Z', 1.5, 'confirmed',
          '2026-09-11T06:05:00.000Z', NULL, NULL
        );
      `);
      raw.close();

      const db = new ReefDatabase(tmpPath);
      try {
        const result = auditDb(db);
        expect(result.findings).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmQuietly(tmpPath);
    }
  });

  it('zero-writes proof: the audited database file is byte-identical afterwards', () => {
    const tmpPath = path.join(
      os.tmpdir(),
      `reef-audit-nowrites-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      // Build a fixture with real corruption to audit.
      const db = new ReefDatabase(tmpPath);
      db.createMissedDose({
        scheduleId: 'sched-1',
        pumpId: 'alk',
        scheduledFor: '2026-09-11T06:00:00.000Z',
        volumeMl: 1.5,
        status: 'completed',
        deferredUntil: null,
        confirmAfter: null,
      });
      db.saveDoseEvent(
        event({ id: 'ev-orphan', source: 'catchup', missedDoseId: 'gone' }),
      );
      db.close();

      const bytesBefore = fs.readFileSync(tmpPath);

      // Re-open READ-ONLY — no journal, no checkpoint, no write path at all.
      const raw = new Database(tmpPath, { readonly: true, fileMustExist: true });
      const result = runIntegrityAudit(createAuditStore(raw), NOW);
      raw.close();

      const bytesAfter = fs.readFileSync(tmpPath);
      expect(bytesAfter.equals(bytesBefore)).toBe(true);
      // The audit really did examine the fixture (1 missed row + 1 event,
      // both corrupt → 2 findings) — this is not a vacuous pass.
      expect(result.findings).toHaveLength(2);
    } finally {
      rmQuietly(tmpPath);
    }
  });
});
