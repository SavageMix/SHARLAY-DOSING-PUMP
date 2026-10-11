import { describe, expect, it, vi } from 'vitest';
import type { DoseEvent, NotificationEventType } from '@reef/shared';
import { ReefDatabase } from '../src/db.js';
import {
  handleFinalizedDose,
  startNotificationSweeper,
} from '../src/notification-hooks.js';
import type { NotificationPriority } from '../src/notifier.js';

// A recording stand-in for the manager: captures notifyIncident /
// evaluateCondition / clear calls so the hooks module can be tested without
// a real notifier.
function createRecordingManager() {
  const incidents: Array<{
    eventType: NotificationEventType;
    key: string;
    title: string;
    body: string;
    priority: NotificationPriority;
  }> = [];
  const conditions: Array<{
    eventType: NotificationEventType;
    key: string;
    condition: boolean;
  }> = [];
  const cleared: Array<{ eventType: NotificationEventType; key: string }> = [];
  return {
    incidents,
    conditions,
    cleared,
    manager: {
      configure: () => {},
      notifyIncident: (
        eventType: NotificationEventType,
        key: string,
        title: string,
        body: string,
        priority: NotificationPriority,
      ) => {
        incidents.push({ eventType, key, title, body, priority });
      },
      evaluateCondition: (
        eventType: NotificationEventType,
        key: string,
        condition: boolean,
        makeMessage: () => {
          title: string;
          body: string;
          priority: NotificationPriority;
        },
      ) => {
        conditions.push({ eventType, key, condition });
        if (condition) makeMessage();
      },
      clear: (eventType: NotificationEventType, key: string) => {
        cleared.push({ eventType, key });
      },
      sendTest: async () => ({ ok: true }),
    },
  };
}

function doseEvent(overrides: Partial<DoseEvent>): DoseEvent {
  return {
    id: 'event-1',
    pumpId: 'alk',
    requestedMl: 2,
    actualMl: null,
    status: 'failed',
    source: 'schedule',
    scheduleId: 'sched-1',
    missedDoseId: null,
    startedAt: new Date('2026-08-23T09:00:00Z').toISOString(),
    finishedAt: new Date('2026-08-23T09:01:00Z').toISOString(),
    error: 'stepper fault',
    ...overrides,
  };
}

describe('handleFinalizedDose', () => {
  it('notifies dose_failed with container name, slot time and volume', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const { incidents, manager } = createRecordingManager();
      handleFinalizedDose(db, manager, doseEvent({ status: 'failed' }));

      expect(incidents).toHaveLength(1);
      expect(incidents[0].eventType).toBe('dose_failed');
      expect(incidents[0].key).toBe('alk');
      expect(incidents[0].title).toBe('[SHARLAY] DOSE FAILED');
      // Container name comes from the seeded containers table.
      expect(incidents[0].body).toContain('Alkalinity');
      expect(incidents[0].body).toContain('2 mL');
      expect(incidents[0].priority).toBe('high');
    } finally {
      db.close();
    }
  });

  it('notifies dose_interrupted with the unknown-volume suffix', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const { incidents, manager } = createRecordingManager();
      handleFinalizedDose(
        db,
        manager,
        doseEvent({ status: 'interrupted', pumpId: 'ca' }),
      );

      expect(incidents).toHaveLength(1);
      expect(incidents[0].eventType).toBe('dose_interrupted');
      expect(incidents[0].key).toBe('ca');
      expect(incidents[0].title).toBe('[SHARLAY] DOSE INTERRUPTED');
      expect(incidents[0].body).toContain('. Unknown volume delivered.');
    } finally {
      db.close();
    }
  });

  it('clears both dose incidents when a dose completes', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const { incidents, cleared, manager } = createRecordingManager();
      handleFinalizedDose(db, manager, doseEvent({ status: 'completed' }));

      expect(incidents).toHaveLength(0);
      expect(cleared).toEqual([
        { eventType: 'dose_failed', key: 'alk' },
        { eventType: 'dose_interrupted', key: 'alk' },
      ]);
    } finally {
      db.close();
    }
  });

  it('never throws even when the manager blows up', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const exploding = {
        configure: () => {},
        notifyIncident: () => {
          throw new Error('boom');
        },
        evaluateCondition: () => {
          throw new Error('boom');
        },
        clear: () => {
          throw new Error('boom');
        },
        sendTest: async () => ({ ok: true }),
      };
      expect(() =>
        handleFinalizedDose(db, exploding, doseEvent({ status: 'failed' })),
      ).not.toThrow();
      expect(() =>
        handleFinalizedDose(db, exploding, doseEvent({ status: 'completed' })),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('startNotificationSweeper', () => {
  it('evaluates container_low from the seeded containers', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const { conditions, manager } = createRecordingManager();
      const sweeper = startNotificationSweeper(db, manager, () => []);
      try {
        sweeper.evaluate();
        // All four reservoirs start full: every container is evaluated, none
        // is low.
        const containerConditions = conditions.filter(
          (c) => c.eventType === 'container_low',
        );
        expect(containerConditions).toHaveLength(4);
        expect(
          containerConditions.filter((c) => c.condition),
        ).toEqual([]);

        conditions.length = 0;
        db.adjustReservoirLevel('alk', 50); // below the 100 mL threshold
        sweeper.evaluate();
        const lows = conditions.filter(
          (c) => c.eventType === 'container_low' && c.condition,
        );
        expect(lows).toEqual([
          { eventType: 'container_low', key: 'alk', condition: true },
        ]);
      } finally {
        sweeper.stop();
      }
    } finally {
      db.close();
    }
  });

  it('reports audit findings only while some are active', () => {
    const db = new ReefDatabase(':memory:');
    try {
      const { conditions, manager } = createRecordingManager();
      const sweeper = startNotificationSweeper(
        db,
        manager,
        () => [
          {
            id: 'container-low:alk',
            check: 'container-low',
            message: 'Alkalinity reservoir is low.',
            pumpId: 'alk',
          },
        ],
      );
      try {
        sweeper.evaluate();
        expect(
          conditions.filter((c) => c.eventType === 'audit_finding'),
        ).toEqual([
          { eventType: 'audit_finding', key: 'audit', condition: true },
        ]);

        conditions.length = 0;
        const clean = startNotificationSweeper(db, manager, () => []);
        try {
          clean.evaluate();
          expect(
            conditions.filter((c) => c.eventType === 'audit_finding'),
          ).toEqual([
            { eventType: 'audit_finding', key: 'audit', condition: false },
          ]);
        } finally {
          clean.stop();
        }
      } finally {
        sweeper.stop();
      }
    } finally {
      db.close();
    }
  });

  it('flags schedule_silent for enabled schedules with 24h of silence only', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
    const makeSchedule = (db: ReefDatabase) =>
      db.createSchedule({
        pumpId: 'alk',
        volumeMl: 1,
        timesPerDay: 1,
        startTime: '09:00',
        repeatEveryNDays: 1,
        enabled: true,
        lastRunAt: null,
      });
    const silentConditions = (db: ReefDatabase) => {
      const { conditions, manager } = createRecordingManager();
      const sweeper = startNotificationSweeper(db, manager, () => []);
      try {
        sweeper.evaluate();
        return conditions.filter((c) => c.eventType === 'schedule_silent');
      } finally {
        sweeper.stop();
      }
    };
    try {
      // No schedules at all: no pump is eligible.
      {
        const db = new ReefDatabase(':memory:');
        try {
          expect(silentConditions(db)).toEqual([]);
        } finally {
          db.close();
        }
      }

      // Enabled alk schedule, no dose activity at all → silent.
      {
        const db = new ReefDatabase(':memory:');
        try {
          makeSchedule(db);
          expect(silentConditions(db)).toEqual([
            { eventType: 'schedule_silent', key: 'alk', condition: true },
          ]);
        } finally {
          db.close();
        }
      }

      // A dose OLDER than 24h does not count as activity: still silent.
      {
        const db = new ReefDatabase(':memory:');
        try {
          makeSchedule(db);
          db.saveDoseEvent(
            doseEvent({
              id: 'old-manual',
              status: 'completed',
              source: 'manual',
              startedAt: new Date('2026-08-23T11:00:00Z').toISOString(),
            }),
          );
          expect(silentConditions(db)).toEqual([
            { eventType: 'schedule_silent', key: 'alk', condition: true },
          ]);
        } finally {
          db.close();
        }
      }

      // A recent manual dose (any status counts as attempted) clears it…
      {
        const db = new ReefDatabase(':memory:');
        try {
          const schedule = makeSchedule(db);
          db.saveDoseEvent(
            doseEvent({
              id: 'recent-manual',
              status: 'failed',
              source: 'manual',
              startedAt: new Date('2026-08-24T10:00:00Z').toISOString(),
            }),
          );
          expect(silentConditions(db)).toEqual([
            { eventType: 'schedule_silent', key: 'alk', condition: false },
          ]);

          // …and disabling the schedule removes the pump from eligibility.
          db.updateSchedule(schedule.id, { enabled: false });
          expect(silentConditions(db)).toEqual([]);
        } finally {
          db.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() prevents further scheduled evaluations', () => {
    vi.useFakeTimers();
    const db = new ReefDatabase(':memory:');
    try {
      const { conditions, manager } = createRecordingManager();
      const sweeper = startNotificationSweeper(db, manager, () => [], {
        intervalMs: 60_000,
      });
      sweeper.stop();
      vi.advanceTimersByTime(10 * 60_000);
      // evaluate() was never called, by timer or otherwise.
      expect(conditions).toEqual([]);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });
});
