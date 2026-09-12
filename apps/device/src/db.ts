import Database from 'better-sqlite3';
import type {
  DoseEvent,
  DoseSchedule,
  MissedDose,
  MissedDoseStatus,
  PumpId,
} from '@reef/shared';
import type { DoseRepository, PumpCalibration } from './engine.js';
import type { SchedulerRepository } from './scheduler.js';
import type { MissedDosesRepository } from './missed-doses.js';

const DEFAULT_CONTAINER_CAPACITY_ML = 1000;
const DEFAULT_SYSTEM_VOLUME_LITRES = 380;

export class ReefDatabase
  implements DoseRepository, SchedulerRepository, MissedDosesRepository
{
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.reconcileInterruptedDoses();
    this.reconcileConfirmedMissedDoses();
    this.seed();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Dose events left with status 'running'/'queued' by a process that died
   * mid-dose never close themselves: the pump physically stopped when the
   * process died, but the record said 'running' forever. On boot, close them
   * as 'interrupted' so History is honest, they do not count toward daily
   * totals as completed (getTodayDoseMl only sums 'completed'), and
   * missed-dose logic treats the slot conservatively (under-delivered).
   */
  private reconcileInterruptedDoses(): void {
    const result = this.db
      .prepare(
        "UPDATE dose_events SET status = 'interrupted' WHERE status IN ('running', 'queued')",
      )
      .run();
    if (result.changes > 0) {
      console.log(
        `[db] Marked ${result.changes} dose event(s) as interrupted (left running/queued by a previous run)`,
      );
    }
  }

  /**
   * Boot-time audit of catch-up doses that were 'confirmed' when the process
   * last died. A confirmed entry whose linked dose event reached a terminal
   * state is closed to match it. A confirmed entry with NO terminal event is
   * suspicious: the fire may have physically started but never recorded, so
   * it must NEVER be silently re-fired — it goes back to 'pending' for the
   * user to decide again, with a loud log line. (This runs after
   * reconcileInterruptedDoses, so any surviving event is already terminal.)
   */
  private reconcileConfirmedMissedDoses(): void {
    const rows = this.db
      .prepare("SELECT id, pump_id FROM missed_doses WHERE status = 'confirmed'")
      .all() as Array<{ id: string; pump_id: PumpId }>;

    for (const row of rows) {
      const event = this.db
        .prepare(
          `SELECT id, status, actual_ml FROM dose_events
           WHERE missed_dose_id = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .get(row.id) as
        | { id: string; status: string; actual_ml: number | null }
        | undefined;

      if (event && ['completed', 'failed', 'interrupted'].includes(event.status)) {
        this.db
          .prepare(
            "UPDATE missed_doses SET status = ?, confirm_after = NULL WHERE id = ? AND status = 'confirmed'",
          )
          .run(event.status, row.id);
        console.log(
          `[db] Closed catch-up ${row.id} (${row.pump_id}) as '${event.status}' from its dose event`,
        );
        continue;
      }

      if (!event) {
        // Never fired (or fired but never even persisted a running event):
        // hand the decision back to the user instead of re-firing.
        this.db
          .prepare(
            "UPDATE missed_doses SET status = 'pending', confirm_after = NULL, deferred_until = NULL WHERE id = ? AND status = 'confirmed'",
          )
          .run(row.id);
        console.warn(
          `[db] SUSPICIOUS: confirmed catch-up ${row.id} (${row.pump_id}) had no completed dose event — reset to 'pending' for re-decision, NOT re-fired`,
        );
      }
      // An event that is somehow still non-terminal (e.g. an unknown future
      // status) falls through untouched rather than being guessed at.
    }
  }

  private initSchema(): void {
    // 1. Tables only. CREATE TABLE IF NOT EXISTS never alters an existing
    //    table, so databases created by older builds open fine at this stage.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pumps (
        pump_id TEXT PRIMARY KEY,
        steps_per_ml REAL,
        container_capacity_ml REAL NOT NULL,
        container_remaining_ml REAL NOT NULL,
        skip_next INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        pump_id TEXT NOT NULL,
        volume_ml REAL NOT NULL,
        times_per_day INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        repeat_every_n_days INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS dose_events (
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

      CREATE TABLE IF NOT EXISTS missed_doses (
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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // 2. Migrations — BEFORE any index or statement referencing migrated
    //    columns. A database created before the snooze/catch-up feature has a
    //    missed_doses table without deferred_until/confirm_after; creating an
    //    index on a missing column here is what brick-booted the service
    //    ("no such column: confirm_after"). Every step is idempotent so a
    //    half-migrated database recovers cleanly on the next boot.
    this.runMigration('schedules table', () => this.migrateSchedulesTable());
    this.runMigration('missed_doses snooze/catch-up columns', () =>
      this.migrateMissedDosesTable(),
    );
    this.runMigration('pumps skip_next column', () => this.migratePumpsTable());
    this.runMigration('dose_events catch-up column', () =>
      this.migrateDoseEventsTable(),
    );

    // Hard gate: never proceed to indexes unless the migrated columns exist.
    this.assertColumnExists('missed_doses', 'deferred_until');
    this.assertColumnExists('missed_doses', 'confirm_after');
    this.assertColumnExists('dose_events', 'missed_dose_id');

    // 3. Indexes last — only after every column they reference is guaranteed
    //    to exist on databases of every vintage.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dose_events_pump_started
        ON dose_events(pump_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_dose_events_schedule_started
        ON dose_events(schedule_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_missed_doses_status
        ON missed_doses(status);
      CREATE INDEX IF NOT EXISTS idx_missed_doses_schedule_for
        ON missed_doses(schedule_id, scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_missed_doses_confirm_after
        ON missed_doses(status, confirm_after);
    `);
  }

  private runMigration(name: string, migrate: () => void): void {
    try {
      migrate();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[db] migration "${name}" failed: ${reason}`);
      throw new Error(`migration "${name}" failed: ${reason}`);
    }
  }

  private assertColumnExists(table: string, column: string): void {
    const row = this.db
      .prepare(
        `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
      )
      .get(column);
    if (!row) {
      throw new Error(
        `migration "missed_doses snooze/catch-up columns" did not produce column ${table}.${column}`,
      );
    }
  }

  /**
   * Existing databases predate the snooze (deferred_until) and delayed
   * catch-up (confirm_after) columns. Add them if missing.
   */
  private migrateMissedDosesTable(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('missed_doses')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('deferred_until')) {
      this.db.exec(
        'ALTER TABLE missed_doses ADD COLUMN deferred_until TEXT',
      );
    }
    if (!names.has('confirm_after')) {
      this.db.exec(
        'ALTER TABLE missed_doses ADD COLUMN confirm_after TEXT',
      );
    }
  }

  /**
   * Existing databases predate the "skip next dose" flag. Add the column if
   * missing. Idempotent: safe on fully migrated and half-migrated databases.
   */
  private migratePumpsTable(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('pumps')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('skip_next')) {
      this.db.exec(
        'ALTER TABLE pumps ADD COLUMN skip_next INTEGER NOT NULL DEFAULT 0',
      );
    }
  }

  /**
   * Existing databases predate the catch-up link column on dose_events. Add it
   * if missing. Idempotent, like every migration step.
   */
  private migrateDoseEventsTable(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('dose_events')")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('missed_dose_id')) {
      this.db.exec(
        'ALTER TABLE dose_events ADD COLUMN missed_dose_id TEXT',
      );
    }
  }

  /**
   * The schedules table moved from a raw cron string to structured fields.
   * If an existing table still has the old `cron` column, drop and recreate
   * the schedules table. Dose history, pump calibrations, and settings are
   * preserved; only the schedule rows are lost and must be recreated.
   */
  private migrateSchedulesTable(): void {
    const info = this.db
      .prepare(
        "SELECT name FROM pragma_table_info('schedules') WHERE name = 'cron'",
      )
      .get() as { name: string } | undefined;

    if (!info) {
      // No old cron column -> nothing to migrate.
      return;
    }

    console.warn(
      'Migrating schedules table: dropping old cron-based schema. ' +
        'Existing schedules will need to be recreated in the app.',
    );

    this.db.exec(`
      DROP TABLE schedules;
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        pump_id TEXT NOT NULL,
        volume_ml REAL NOT NULL,
        times_per_day INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        repeat_every_n_days INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT
      );
    `);
  }

  private seed(): void {
    const existing = this.db
      .prepare('SELECT COUNT(*) as count FROM pumps')
      .get() as { count: number };

    if (existing.count === 0) {
      const insert = this.db.prepare(
        `INSERT INTO pumps (pump_id, steps_per_ml, container_capacity_ml, container_remaining_ml)
         VALUES (?, NULL, ?, ?)`,
      );
      for (const pumpId of ['alk', 'ca', 'no3', 'po4'] as PumpId[]) {
        insert.run(pumpId, DEFAULT_CONTAINER_CAPACITY_ML, DEFAULT_CONTAINER_CAPACITY_ML);
      }
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO settings (key, value) VALUES ('system_volume_litres', ?)`,
      )
      .run(DEFAULT_SYSTEM_VOLUME_LITRES.toString());
  }

  // ---------------------------------------------------------------------------
  // Engine: DoseRepository
  // ---------------------------------------------------------------------------

  getSystemVolumeLitres(): number {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'system_volume_litres'")
      .get() as { value: string } | undefined;
    return row ? parseFloat(row.value) : DEFAULT_SYSTEM_VOLUME_LITRES;
  }

  setSystemVolumeLitres(value: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('system_volume_litres', ?)",
      )
      .run(value.toString());
  }

  getTodayDoseMl(pumpId: PumpId): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(actual_ml), 0) as total
         FROM dose_events
         WHERE pump_id = ?
           AND status = 'completed'
           AND source IN ('manual', 'schedule', 'catchup')
           AND date(started_at) = date('now')`,
      )
      .get(pumpId) as { total: number };
    return row.total;
  }

  getPumpCalibration(pumpId: PumpId): PumpCalibration {
    const row = this.db
      .prepare('SELECT pump_id, steps_per_ml FROM pumps WHERE pump_id = ?')
      .get(pumpId) as
      | { pump_id: PumpId; steps_per_ml: number | null }
      | undefined;
    if (!row) {
      throw new Error(`Unknown pump ${pumpId}`);
    }
    return {
      pumpId: row.pump_id,
      stepsPerMl: row.steps_per_ml ?? null,
    };
  }

  saveDoseEvent(event: DoseEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dose_events (
          id, pump_id, requested_ml, actual_ml, status, source, schedule_id,
          missed_dose_id, started_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.pumpId,
        event.requestedMl,
        event.actualMl ?? null,
        event.status,
        event.source,
        event.scheduleId ?? null,
        event.missedDoseId ?? null,
        event.startedAt,
        event.finishedAt ?? null,
        event.error ?? null,
      );
  }

  /**
   * Persist a finished dose event AND close its missed_doses entry in the
   * SAME transaction. A crash between the physical dose and this write must
   * never leave a confirmed entry eligible to re-fire (boot reconciliation
   * in the constructor recovers those). Non-catch-up events behave exactly
   * like saveDoseEvent.
   */
  finalizeDoseEvent(event: DoseEvent): void {
    const save = this.db.prepare(
      `INSERT OR REPLACE INTO dose_events (
        id, pump_id, requested_ml, actual_ml, status, source, schedule_id,
        missed_dose_id, started_at, finished_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const closeEntry = this.db.prepare(
      `UPDATE missed_doses
       SET status = ?, confirm_after = NULL
       WHERE id = ? AND status = 'confirmed'`,
    );
    const entryStatus =
      event.status === 'completed'
        ? 'completed'
        : event.status === 'interrupted'
          ? 'interrupted'
          : 'failed';

    this.db.transaction(() => {
      save.run(
        event.id,
        event.pumpId,
        event.requestedMl,
        event.actualMl ?? null,
        event.status,
        event.source,
        event.scheduleId ?? null,
        event.missedDoseId ?? null,
        event.startedAt,
        event.finishedAt ?? null,
        event.error ?? null,
      );
      if (event.missedDoseId) {
        closeEntry.run(entryStatus, event.missedDoseId);
      }
    })();
  }

  decrementContainer(pumpId: PumpId, amountMl: number): void {
    this.db
      .prepare(
        `UPDATE pumps
         SET container_remaining_ml = MAX(0, container_remaining_ml - ?)
         WHERE pump_id = ?`,
      )
      .run(amountMl, pumpId);
  }

  // ---------------------------------------------------------------------------
  // Schedules CRUD
  // ---------------------------------------------------------------------------

  createSchedule(
    schedule: Omit<DoseSchedule, 'id'>,
  ): DoseSchedule {
    const id = crypto.randomUUID();
    const lastRunAt = schedule.lastRunAt ?? null;
    this.db
      .prepare(
        `INSERT INTO schedules (
          id, pump_id, volume_ml, times_per_day, start_time,
          repeat_every_n_days, enabled, last_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        schedule.pumpId,
        schedule.volumeMl,
        schedule.timesPerDay,
        schedule.startTime,
        schedule.repeatEveryNDays,
        schedule.enabled ? 1 : 0,
        lastRunAt,
      );
    return { ...schedule, id, lastRunAt };
  }

  getSchedules(): DoseSchedule[] {
    const rows = this.db
      .prepare('SELECT * FROM schedules')
      .all() as Array<{
        id: string;
        pump_id: PumpId;
        volume_ml: number;
        times_per_day: number;
        start_time: string;
        repeat_every_n_days: number;
        enabled: number;
        last_run_at: string | null;
      }>;
    return rows.map((row) => ({
      id: row.id,
      pumpId: row.pump_id,
      volumeMl: row.volume_ml,
      timesPerDay: row.times_per_day,
      startTime: row.start_time,
      repeatEveryNDays: row.repeat_every_n_days,
      enabled: Boolean(row.enabled),
      lastRunAt: row.last_run_at,
    }));
  }

  getEnabledSchedules(): DoseSchedule[] {
    return this.getSchedules().filter((s) => s.enabled);
  }

  updateSchedule(
    id: string,
    partial: Partial<Omit<DoseSchedule, 'id'>>,
  ): DoseSchedule {
    const existing = this.getSchedules().find((s) => s.id === id);
    if (!existing) {
      throw new Error(`Schedule ${id} not found`);
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (partial.pumpId !== undefined) {
      updates.push('pump_id = ?');
      values.push(partial.pumpId);
    }
    if (partial.volumeMl !== undefined) {
      updates.push('volume_ml = ?');
      values.push(partial.volumeMl);
    }
    if (partial.timesPerDay !== undefined) {
      updates.push('times_per_day = ?');
      values.push(partial.timesPerDay);
    }
    if (partial.startTime !== undefined) {
      updates.push('start_time = ?');
      values.push(partial.startTime);
    }
    if (partial.repeatEveryNDays !== undefined) {
      updates.push('repeat_every_n_days = ?');
      values.push(partial.repeatEveryNDays);
    }
    if (partial.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(partial.enabled ? 1 : 0);
    }
    if (partial.lastRunAt !== undefined) {
      updates.push('last_run_at = ?');
      values.push(partial.lastRunAt);
    }

    if (updates.length > 0) {
      values.push(id);
      this.db
        .prepare(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`)
        .run(...values);
    }

    return { ...existing, ...partial };
  }

  deleteSchedule(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------------------
  // Scheduler: SchedulerRepository
  // ---------------------------------------------------------------------------

  updateScheduleLastRunAt(id: string, lastRunAt: string): void {
    this.db
      .prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?')
      .run(lastRunAt, id);
  }

  getScheduleDoseEventsAfter(
    scheduleId: string,
    after: string,
  ): DoseEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dose_events
         WHERE schedule_id = ? AND started_at > ?
         ORDER BY started_at ASC`,
      )
      .all(scheduleId, after) as Array<{
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
      }>;

    return rows.map((row) => ({
      id: row.id,
      pumpId: row.pump_id,
      requestedMl: row.requested_ml,
      actualMl: row.actual_ml,
      status: row.status as DoseEvent['status'],
      source: row.source as DoseEvent['source'],
      scheduleId: row.schedule_id,
      missedDoseId: row.missed_dose_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
    }));
  }

  // ---------------------------------------------------------------------------
  // Missed doses
  // ---------------------------------------------------------------------------

  createMissedDose(
    missed: Omit<MissedDose, 'id' | 'createdAt'>,
  ): MissedDose {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO missed_doses (
          id, schedule_id, pump_id, scheduled_for, volume_ml, status,
          created_at, deferred_until, confirm_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        missed.scheduleId,
        missed.pumpId,
        missed.scheduledFor,
        missed.volumeMl,
        missed.status,
        createdAt,
        missed.deferredUntil,
        missed.confirmAfter,
      );
    return { ...missed, id, createdAt };
  }

  private mapMissedDoseRow(row: Record<string, unknown>): MissedDose {
    return {
      id: row.id as string,
      scheduleId: row.schedule_id as string,
      pumpId: row.pump_id as PumpId,
      scheduledFor: row.scheduled_for as string,
      volumeMl: row.volume_ml as number,
      status: row.status as MissedDoseStatus,
      createdAt: row.created_at as string,
      deferredUntil: (row.deferred_until as string | null) ?? null,
      confirmAfter: (row.confirm_after as string | null) ?? null,
    };
  }

  /**
   * Pending entries visible to the app. Entries snoozed via "Decide later"
   * (deferred_until in the future) are hidden until the horizon passes —
   * unless includeSnoozed is set, in which case they are returned too (the
   * app uses this to keep a tappable banner alive during the snooze).
   */
  getPendingMissedDoses(now: Date, includeSnoozed = false): MissedDose[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM missed_doses
         WHERE status = 'pending'
           ${includeSnoozed ? '' : 'AND (deferred_until IS NULL OR deferred_until <= ?)'}
         ORDER BY scheduled_for ASC`,
      )
      .all(...(includeSnoozed ? [] : [now.toISOString()])) as Record<
      string,
      unknown
    >[];

    return rows.map((row) => this.mapMissedDoseRow(row));
  }

  getMissedDoseById(id: string): MissedDose | undefined {
    const row = this.db
      .prepare('SELECT * FROM missed_doses WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.mapMissedDoseRow(row);
  }

  /**
   * Terminal entries (skipped/dismissed, expired, or whose catch-up dose
   * reached a final state) for the RESOLVED section of the Catch-ups page.
   * Read-only. The time window is on created_at (detection time) — the table
   * has no resolved-at stamp, and for the page's purpose ("did that dose
   * actually happen?") misses detected within the window are the right set.
   */
  getResolvedMissedDoses(now: Date, sinceHours: number): MissedDose[] {
    const cutoff = new Date(now.getTime() - sinceHours * 3_600_000);
    const rows = this.db
      .prepare(
        `SELECT * FROM missed_doses
         WHERE status IN ('dismissed', 'expired', 'completed', 'failed', 'interrupted')
           AND created_at >= ?
         ORDER BY scheduled_for ASC`,
      )
      .all(cutoff.toISOString()) as Record<string, unknown>[];

    return rows.map((row) => this.mapMissedDoseRow(row));
  }

  updateMissedDoseStatus(id: string, status: MissedDoseStatus): void {
    this.db
      .prepare("UPDATE missed_doses SET status = ? WHERE id = ?")
      .run(status, id);
  }

  /** "Decide later": hide every pending entry until `until`. */
  snoozePendingMissedDoses(until: string): void {
    this.db
      .prepare(
        `UPDATE missed_doses SET deferred_until = ?
         WHERE status = 'pending'`,
      )
      .run(until);
  }

  setMissedDoseConfirmAfter(id: string, confirmAfter: string | null): void {
    this.db
      .prepare('UPDATE missed_doses SET confirm_after = ? WHERE id = ?')
      .run(confirmAfter, id);
  }

  /**
   * Catch-up doses confirmed but not yet fired (delayed for per-pump spacing).
   */
  getDueScheduledConfirmations(now: Date): MissedDose[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM missed_doses
         WHERE status = 'confirmed' AND confirm_after IS NOT NULL AND confirm_after <= ?
         ORDER BY confirm_after ASC`,
      )
      .all(now.toISOString()) as Record<string, unknown>[];

    return rows.map((row) => this.mapMissedDoseRow(row));
  }

  expireMissedDosesBefore(threshold: string): void {
    this.db
      .prepare(
        `UPDATE missed_doses
         SET status = 'expired'
         WHERE status = 'pending' AND created_at < ?`,
      )
      .run(threshold);
  }

  /**
   * Dedupe across ALL statuses: a slot that was already handled — dismissed,
   * confirmed, or expired — must never resurface as a new pending entry.
   */
  hasPendingMissedDoseForSlot(
    scheduleId: string,
    scheduledFor: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM missed_doses
         WHERE schedule_id = ? AND scheduled_for = ?`,
      )
      .get(scheduleId, scheduledFor) as { count: number };
    return row.count > 0;
  }

  // ---------------------------------------------------------------------------
  // Containers
  // ---------------------------------------------------------------------------

  refillContainer(pumpId: PumpId, amountMl?: number): void {
    if (amountMl === undefined) {
      this.db
        .prepare(
          `UPDATE pumps
           SET container_remaining_ml = container_capacity_ml
           WHERE pump_id = ?`,
        )
        .run(pumpId);
    } else {
      this.db
        .prepare(
          `UPDATE pumps
           SET container_remaining_ml = MIN(
             container_capacity_ml,
             container_remaining_ml + ?
           )
           WHERE pump_id = ?`,
        )
        .run(amountMl, pumpId);
    }
  }

  getContainerRemainingMl(pumpId: PumpId): number {
    const row = this.db
      .prepare(
        'SELECT container_remaining_ml FROM pumps WHERE pump_id = ?',
      )
      .get(pumpId) as { container_remaining_ml: number } | undefined;
    if (!row) {
      throw new Error(`Unknown pump ${pumpId}`);
    }
    return row.container_remaining_ml;
  }

  // ---------------------------------------------------------------------------
  // Pumps / calibration / containers for the API
  // ---------------------------------------------------------------------------

  updatePumpCalibration(pumpId: PumpId, stepsPerMl: number): void {
    const result = this.db
      .prepare('UPDATE pumps SET steps_per_ml = ? WHERE pump_id = ?')
      .run(stepsPerMl, pumpId);
    if (result.changes === 0) {
      throw new Error(`Unknown pump ${pumpId}`);
    }
  }

  setContainerCapacity(pumpId: PumpId, capacityMl: number): void {
    const result = this.db
      .prepare(
        'UPDATE pumps SET container_capacity_ml = ? WHERE pump_id = ?',
      )
      .run(capacityMl, pumpId);
    if (result.changes === 0) {
      throw new Error(`Unknown pump ${pumpId}`);
    }
  }

  setPumpSkipNext(pumpId: PumpId, skipNext: boolean): void {
    const result = this.db
      .prepare('UPDATE pumps SET skip_next = ? WHERE pump_id = ?')
      .run(skipNext ? 1 : 0, pumpId);
    if (result.changes === 0) {
      throw new Error(`Unknown pump ${pumpId}`);
    }
  }

  getPumpSkipNext(pumpId: PumpId): boolean {
    const row = this.db
      .prepare('SELECT skip_next FROM pumps WHERE pump_id = ?')
      .get(pumpId) as { skip_next: number } | undefined;
    if (!row) {
      throw new Error(`Unknown pump ${pumpId}`);
    }
    return row.skip_next === 1;
  }

  getAllPumps(): Array<{
    pumpId: PumpId;
    stepsPerMl: number | null;
    containerCapacityMl: number;
    containerRemainingMl: number;
    skipNext: boolean;
  }> {
    const rows = this.db
      .prepare(
        'SELECT pump_id, steps_per_ml, container_capacity_ml, container_remaining_ml, skip_next FROM pumps',
      )
      .all() as Array<{
        pump_id: PumpId;
        steps_per_ml: number | null;
        container_capacity_ml: number;
        container_remaining_ml: number;
        skip_next: number;
      }>;

    return rows.map((row) => ({
      pumpId: row.pump_id,
      stepsPerMl: row.steps_per_ml,
      containerCapacityMl: row.container_capacity_ml,
      containerRemainingMl: row.container_remaining_ml,
      skipNext: row.skip_next === 1,
    }));
  }

  getHistory(
    options: {
      pumpId?: PumpId;
      days?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): { events: DoseEvent[]; total: number } {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    // Prime events are logged for audit but never shown in dose history.
    conditions.push("source != 'prime'");

    if (options.pumpId) {
      conditions.push('pump_id = ?');
      params.push(options.pumpId);
    }
    if (options.days !== undefined && options.days > 0) {
      conditions.push("started_at >= datetime('now', '-' || ? || ' days')");
      params.push(options.days);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM dose_events ${where}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM dose_events ${where}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
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
      }>;

    const events = rows.map((row) => ({
      id: row.id,
      pumpId: row.pump_id,
      requestedMl: row.requested_ml,
      actualMl: row.actual_ml,
      status: row.status as DoseEvent['status'],
      source: row.source as DoseEvent['source'],
      scheduleId: row.schedule_id,
      missedDoseId: row.missed_dose_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
    }));

    return { events, total: totalRow.total };
  }
}
