import Database from 'better-sqlite3';
import {
  getMissedDueDates,
  getPreviousDueDate,
  type DoseSchedule,
  type DoseEvent,
  type IntegrityFinding,
  type PumpId,
} from '@reef/shared';
import { isSlotHandled } from './missed-doses.js';

/**
 * Boot-time integrity audit — a SELECT-only consistency observer.
 *
 * Product safety philosophy: SHARLAY never doses unscheduled liquid without
 * the owner's explicit approval, and the audit extends that to its own
 * bookkeeping: it NEVER writes to the database, NEVER touches the engine, and
 * NEVER fires, re-fires, corrects, or dismisses anything. It detects
 * disagreements in the dosing record, reports them (journal + /api/status),
 * and leaves every decision to the human.
 *
 * The store is created from a raw better-sqlite3 connection so the zero-writes
 * guarantee is testable: a test opens the fixture file with
 * `{ readonly: true }` and proves the bytes are untouched afterwards.
 */

export interface AuditMissedRow {
  id: string;
  pumpId: PumpId;
  scheduledFor: string;
  status: string;
}

export interface AuditEventRow {
  id: string;
  pumpId: PumpId;
  source: string;
  missedDoseId: string | null;
  startedAt: string;
  status: string;
}

/** Every query the audit needs. All implementations must be pure SELECTs. */
export interface IntegrityAuditStore {
  listMissedDoses(): AuditMissedRow[];
  listDoseEvents(): AuditEventRow[];
  countCatchupEventsForMissed(missedDoseId: string): number;
  missedDoseExists(id: string): boolean;
  getEnabledSchedules(): DoseSchedule[];
  getScheduleDoseEventsAfter(scheduleId: string, afterIso: string): DoseEvent[];
  /** Any missed_doses row for this exact slot, in ANY status — a decision was made. */
  hasMissedDoseForSlotAnyStatus(
    scheduleId: string,
    scheduledForIso: string,
  ): boolean;
}

/** Read-only store over a raw connection. SQL lives here and nowhere else. */
export function createAuditStore(conn: Database.Database): IntegrityAuditStore {
  const missedStmt = conn.prepare(
    `SELECT id, pump_id, scheduled_for, status FROM missed_doses`,
  );
  const eventsStmt = conn.prepare(
    `SELECT id, pump_id, source, missed_dose_id, started_at, status
     FROM dose_events`,
  );
  const catchupCountStmt = conn.prepare(
    `SELECT COUNT(*) AS count FROM dose_events WHERE missed_dose_id = ?`,
  );
  const missedExistsStmt = conn.prepare(
    `SELECT 1 FROM missed_doses WHERE id = ?`,
  );
  const schedulesStmt = conn.prepare(
    `SELECT id, pump_id, volume_ml, times_per_day, start_time,
            repeat_every_n_days, enabled, last_run_at
     FROM schedules WHERE enabled = 1`,
  );
  const scheduleEventsStmt = conn.prepare(
    `SELECT id, pump_id, requested_ml, actual_ml, status, source,
            schedule_id, missed_dose_id, started_at, finished_at, error
     FROM dose_events
     WHERE schedule_id = ? AND started_at > ?
     ORDER BY started_at ASC`,
  );
  const slotStmt = conn.prepare(
    `SELECT 1 FROM missed_doses
     WHERE schedule_id = ? AND scheduled_for = ? LIMIT 1`,
  );

  return {
    listMissedDoses: () =>
      (
        missedStmt.all() as Array<{
          id: string;
          pump_id: PumpId;
          scheduled_for: string;
          status: string;
        }>
      ).map((row) => ({
        id: row.id,
        pumpId: row.pump_id,
        scheduledFor: row.scheduled_for,
        status: row.status,
      })),
    listDoseEvents: () =>
      (
        eventsStmt.all() as Array<{
          id: string;
          pump_id: PumpId;
          source: string;
          missed_dose_id: string | null;
          started_at: string;
          status: string;
        }>
      ).map((row) => ({
        id: row.id,
        pumpId: row.pump_id,
        source: row.source,
        missedDoseId: row.missed_dose_id,
        startedAt: row.started_at,
        status: row.status,
      })),
    countCatchupEventsForMissed: (missedDoseId) =>
      (
        catchupCountStmt.get(missedDoseId) as { count: number }
      ).count,
    missedDoseExists: (id) => missedExistsStmt.get(id) !== undefined,
    getEnabledSchedules: () =>
      (
        schedulesStmt.all() as Array<{
          id: string;
          pump_id: PumpId;
          volume_ml: number;
          times_per_day: number;
          start_time: string;
          repeat_every_n_days: number;
          enabled: number;
          last_run_at: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        pumpId: row.pump_id,
        volumeMl: row.volume_ml,
        timesPerDay: row.times_per_day,
        startTime: row.start_time,
        repeatEveryNDays: row.repeat_every_n_days,
        enabled: row.enabled === 1,
        lastRunAt: row.last_run_at,
      })),
    getScheduleDoseEventsAfter: (scheduleId, afterIso) =>
      (
        scheduleEventsStmt.all(scheduleId, afterIso) as Array<{
          id: string;
          pump_id: PumpId;
          requested_ml: number;
          actual_ml: number | null;
          status: string;
          source: string;
          schedule_id: string | null;
          missed_dose_id: string | null;
          started_at: string;
          finished_at: string | null;
          error: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        pumpId: row.pump_id,
        requestedMl: row.requested_ml,
        actualMl: row.actual_ml,
        status: row.status,
        source: row.source,
        scheduleId: row.schedule_id,
        missedDoseId: row.missed_dose_id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        error: row.error,
      })) as DoseEvent[],
    hasMissedDoseForSlotAnyStatus: (scheduleId, scheduledForIso) =>
      slotStmt.get(scheduleId, scheduledForIso) !== undefined,
  };
}

/**
 * Slots older than this are deliberately forgotten by missed-dose detection
 * (no entry is ever created for them), so the audit must not demand a
 * resolution for them either — that would flag designed behaviour. Mirrors
 * DEFAULT_LOOKBACK_HOURS in missed-doses.ts.
 */
export const AUDIT_SLOT_LOOKBACK_HOURS = 24;

/** Backstop against a pathological lastRunAt anchor enumerating huge slot lists. */
const MAX_SLOTS_PER_SCHEDULE = 500;

export interface AuditResult {
  findings: IntegrityFinding[];
  /** Records examined — drives the quiet "N records verified" pass line. */
  verified: number;
}

function slotLabel(iso: string): string {
  // Device-local wall clock, matching how missed slots are shown in the app.
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${d.toLocaleDateString()} ${time}`;
}

/**
 * Run all four checks. `now` is injectable for tests; the audit reads nothing
 * but the store and never mutates either.
 */
export function runIntegrityAudit(
  store: IntegrityAuditStore,
  now: Date = new Date(),
): AuditResult {
  const findings: IntegrityFinding[] = [];
  const missed = store.listMissedDoses();
  const events = store.listDoseEvents();
  let verified = missed.length + events.length;

  // --- Check 1: every 'completed' missed_doses row has exactly one linked
  // dose_events row. Zero links = a phantom completion claiming delivery that
  // never physically happened; several = duplicate catch-up records.
  for (const m of missed) {
    if (m.status !== 'completed') continue;
    const count = store.countCatchupEventsForMissed(m.id);
    if (count === 0) {
      findings.push({
        id: `completed-without-event:${m.id}`,
        check: 'completed-without-event',
        message:
          `${m.pumpId.toUpperCase()} catch-up for the missed ${slotLabel(m.scheduledFor)} ` +
          `dose is marked completed, but no dose event exists for it. The delivery ` +
          `was never physically recorded.`,
        pumpId: m.pumpId,
        missedSlotIso: m.scheduledFor,
      });
    } else if (count > 1) {
      findings.push({
        id: `completed-without-event:${m.id}`,
        check: 'completed-without-event',
        message:
          `${m.pumpId.toUpperCase()} catch-up for the missed ${slotLabel(m.scheduledFor)} ` +
          `dose has ${count} dose events linked — exactly one delivery should exist.`,
        pumpId: m.pumpId,
        missedSlotIso: m.scheduledFor,
      });
    }
  }

  // --- Check 2: every source='catchup' dose event links back to a real
  // missed_doses row. A catch-up event with no parent is an orphan — liquid
  // was dosed with no record of which missed slot it answers.
  for (const e of events) {
    if (e.source !== 'catchup') continue;
    if (!e.missedDoseId) {
      findings.push({
        id: `orphan-catchup-event:${e.id}`,
        check: 'orphan-catchup-event',
        message:
          `A ${e.pumpId.toUpperCase()} catch-up dose fired on ${slotLabel(e.startedAt)} ` +
          `with no missed-dose record linked to it.`,
        pumpId: e.pumpId,
      });
    } else if (!store.missedDoseExists(e.missedDoseId)) {
      findings.push({
        id: `orphan-catchup-event:${e.id}`,
        check: 'orphan-catchup-event',
        message:
          `A ${e.pumpId.toUpperCase()} catch-up dose fired on ${slotLabel(e.startedAt)} ` +
          `links to a missed-dose record (${e.missedDoseId}) that no longer exists.`,
        pumpId: e.pumpId,
      });
    }
  }

  // --- Check 3: every past slot within the detection lookback has a
  // resolution — a handled dose event (completed or deliberately skipped) or
  // a missed_doses entry in any status (the human decided). A slot with
  // neither fell through every crack: it never fired AND was never offered
  // for confirmation.
  const cutoff = new Date(
    now.getTime() - AUDIT_SLOT_LOOKBACK_HOURS * 60 * 60 * 1000,
  );
  const schedules = store.getEnabledSchedules();
  for (const schedule of schedules) {
    let slots: Date[];
    const lastRunAt = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    if (!lastRunAt) {
      // No anchor: detection arms at the most recent slot (see
      // armScheduleAtPreviousDue) — that is the only slot to verify.
      const previousDue = getPreviousDueDate(schedule, now);
      slots = previousDue ? [previousDue] : [];
    } else {
      // Slots are enumerated exactly as detection enumerates them; only
      // in-lookback slots are required to have a resolution (older ones are
      // forgotten by design).
      slots = getMissedDueDates(schedule, lastRunAt, now).filter(
        (slot) => slot >= cutoff,
      );
    }

    for (const slot of slots.slice(0, MAX_SLOTS_PER_SCHEDULE)) {
      verified += 1;
      const slotIso = slot.toISOString();
      if (store.hasMissedDoseForSlotAnyStatus(schedule.id, slotIso)) continue;

      const after = new Date(slot.getTime() - 1).toISOString();
      const handled = store
        .getScheduleDoseEventsAfter(schedule.id, after)
        .find(
          (event) =>
            isSlotHandled(event) && new Date(event.startedAt) >= slot,
        );
      if (handled) continue;

      findings.push({
        id: `unresolved-slot:${schedule.id}:${slotIso}`,
        check: 'unresolved-slot',
        message:
          `The ${slotLabel(slotIso)} ${schedule.pumpId.toUpperCase()} dose never fired ` +
          `and was never recorded as missed — it has no resolution of any kind.`,
        pumpId: schedule.pumpId,
        missedSlotIso: slotIso,
      });
    }
  }

  // --- Check 4: boot reconciliation (which runs in the ReefDatabase
  // constructor, before the audit) must have left no 'confirmed' rows — a
  // stuck row means a catch-up is eligible to fire without the engine having
  // closed it. The audit only VERIFIES that pass ran; it does not perform it.
  for (const m of missed) {
    if (m.status !== 'confirmed') continue;
    findings.push({
      id: `stuck-confirmed:${m.id}`,
      check: 'stuck-confirmed',
      message:
        `The ${m.pumpId.toUpperCase()} catch-up for the missed ${slotLabel(m.scheduledFor)} ` +
        `dose is still marked confirmed after boot reconciliation — it may be eligible ` +
        `to fire without a recorded outcome.`,
      pumpId: m.pumpId,
      missedSlotIso: m.scheduledFor,
    });
  }

  return { findings, verified };
}
