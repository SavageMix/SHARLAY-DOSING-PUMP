import Database from 'better-sqlite3';
import type {
  DoseEvent,
  DoseSchedule,
  PumpId,
} from '@reef/shared';
import type { DoseRepository, PumpCalibration } from './engine.js';
import type { SchedulerRepository } from './scheduler.js';

const DEFAULT_CONTAINER_CAPACITY_ML = 1000;
const DEFAULT_SYSTEM_VOLUME_LITRES = 380;

export class ReefDatabase implements DoseRepository, SchedulerRepository {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.seed();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pumps (
        pump_id TEXT PRIMARY KEY,
        steps_per_ml REAL,
        container_capacity_ml REAL NOT NULL,
        container_remaining_ml REAL NOT NULL
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
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dose_events_pump_started
        ON dose_events(pump_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_dose_events_schedule_started
        ON dose_events(schedule_id, started_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
          started_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.pumpId,
        event.requestedMl,
        event.actualMl ?? null,
        event.status,
        event.source,
        event.scheduleId ?? null,
        event.startedAt,
        event.finishedAt ?? null,
        event.error ?? null,
      );
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
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
    }));
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

  getAllPumps(): Array<{
    pumpId: PumpId;
    stepsPerMl: number | null;
    containerCapacityMl: number;
    containerRemainingMl: number;
  }> {
    const rows = this.db
      .prepare(
        'SELECT pump_id, steps_per_ml, container_capacity_ml, container_remaining_ml FROM pumps',
      )
      .all() as Array<{
        pump_id: PumpId;
        steps_per_ml: number | null;
        container_capacity_ml: number;
        container_remaining_ml: number;
      }>;

    return rows.map((row) => ({
      pumpId: row.pump_id,
      stepsPerMl: row.steps_per_ml,
      containerCapacityMl: row.container_capacity_ml,
      containerRemainingMl: row.container_remaining_ml,
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
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      error: row.error,
    }));

    return { events, total: totalRow.total };
  }
}
