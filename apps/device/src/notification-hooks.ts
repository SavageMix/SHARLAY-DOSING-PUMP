import type {
  DoseEvent,
  IntegrityFinding,
  NotificationSettings,
  PumpId,
  UpdateNotificationSettingsRequest,
} from '@reef/shared';
import type { ReefDatabase } from './db.js';
import {
  createNtfyNotifier,
  createTelegramNotifier,
  type Notifier,
} from './notifier.js';
import {
  createNotificationManager,
  maskNotificationSettings,
  type FullNotificationSettings,
  type NotificationManager,
} from './notifications.js';

/** Device-local HH:MM for a dose event's start. */
function formatStartedAtHHMM(startedAt: string): string {
  const d = new Date(startedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Route a finalized dose event to the notification manager:
 * - failed / interrupted → an incident for that pump (reminders at the
 *   configured repeat interval until a dose for the pump completes);
 * - completed → clears both dose_failed and dose_interrupted incidents so a
 *   later failure fires immediately again.
 * Fully defensive: never throws, safe to wire straight into the engine and
 * the boot-reconciliation callbacks.
 */
export function handleFinalizedDose(
  db: ReefDatabase,
  manager: NotificationManager,
  event: DoseEvent,
): void {
  try {
    if (event.status === 'completed') {
      manager.clear('dose_failed', event.pumpId);
      manager.clear('dose_interrupted', event.pumpId);
      return;
    }
    if (event.status !== 'failed' && event.status !== 'interrupted') return;

    const eventType =
      event.status === 'failed' ? 'dose_failed' : 'dose_interrupted';
    const label = event.status === 'failed' ? 'DOSE FAILED' : 'DOSE INTERRUPTED';
    const containerName =
      db.getContainers().find((c) => c.pumpId === event.pumpId)?.name ??
      event.pumpId.toUpperCase();
    const suffix = event.status === 'interrupted' ? '. Unknown volume delivered.' : '';
    manager.notifyIncident(
      eventType,
      event.pumpId,
      `[SHARLAY] ${label}`,
      `${containerName} ${formatStartedAtHHMM(event.startedAt)} slot (${event.requestedMl} mL)${suffix}`,
      'high',
    );
  } catch (error) {
    console.error(
      '[notifications] handleFinalizedDose failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

export interface NotificationSweeper {
  /** Stop the periodic timer and the delayed first run. */
  stop(): void;
  /**
   * One evaluation pass — exported so tests can drive it directly without
   * touching timers.
   */
  evaluate(): void;
}

const SCHEDULE_SILENCE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Hourly background check for persistent conditions: reservoir low levels,
 * active integrity audit findings, and pumps whose enabled schedules have
 * produced no dose attempt (any status) in the last 24h. Each condition is
 * fed through the manager's evaluateCondition so incidents are edge-triggered
 * and clear themselves when the condition resolves.
 *
 * Timers are unref'd so a short-lived process (or a test that forgets stop())
 * is never held open.
 */
export function startNotificationSweeper(
  db: ReefDatabase,
  manager: NotificationManager,
  getFindings: () => IntegrityFinding[],
  options: { intervalMs?: number; now?: () => Date } = {},
): NotificationSweeper {
  const intervalMs = options.intervalMs ?? 3_600_000;
  const now = options.now ?? (() => new Date());

  const evaluate = (): void => {
    try {
      for (const container of db.getContainers()) {
        manager.evaluateCondition(
          'container_low',
          container.pumpId,
          container.low,
          () => ({
            title: '[SHARLAY] RESERVOIR LOW',
            body: `${container.name} ${Math.round(container.currentMl)} mL left (threshold ${Math.round(container.lowThresholdMl)} mL)`,
            priority: 'high',
          }),
        );
      }

      const findings = getFindings();
      manager.evaluateCondition(
        'audit_finding',
        'audit',
        findings.length > 0,
        () => ({
          title: '[SHARLAY] AUDIT FINDINGS',
          body: `${findings.length} integrity finding(s) active — see the app for details`,
          priority: 'default',
        }),
      );

      const scheduledPumpIds = new Set<PumpId>();
      for (const schedule of db.getEnabledSchedules()) {
        scheduledPumpIds.add(schedule.pumpId);
      }
      for (const pumpId of scheduledPumpIds) {
        const lastActivityAt = db.getLastDoseActivityAt(pumpId);
        const silent =
          lastActivityAt === null ||
          now().getTime() - new Date(lastActivityAt).getTime() >=
            SCHEDULE_SILENCE_WINDOW_MS;
        const containerName =
          db.getContainers().find((c) => c.pumpId === pumpId)?.name ??
          pumpId.toUpperCase();
        manager.evaluateCondition(
          'schedule_silent',
          pumpId,
          silent,
          () => ({
            title: '[SHARLAY] SCHEDULE SILENT',
            body: `${containerName}: no completed/attempted dose in 24h`,
            priority: 'low',
          }),
        );
      }
    } catch (error) {
      console.error(
        '[notifications] sweeper evaluation failed:',
        error instanceof Error ? error.message : error,
      );
    }
  };

  const interval = setInterval(evaluate, intervalMs);
  interval.unref?.();
  const firstRun = setTimeout(evaluate, 30_000);
  firstRun.unref?.();

  return {
    evaluate,
    stop: () => {
      clearInterval(interval);
      clearTimeout(firstRun);
    },
  };
}

/**
 * Build the notifier for the configured service. An incompletely configured
 * service yields a no-op notifier that warns ONCE — the manager and dosing
 * paths stay safe, and sendTest reports 'Notifications not configured'.
 */
export function createNotifierFromSettings(
  settings: FullNotificationSettings,
): Notifier {
  const noop = (reason: string): Notifier => {
    let warned = false;
    return {
      async send() {
        if (!warned) {
          warned = true;
          console.warn(`[notifications] ${reason}`);
        }
      },
    };
  };

  if (settings.service === 'ntfy') {
    if (settings.topic.trim() === '') {
      return noop('ntfy topic is empty — notifications disabled until configured');
    }
    return createNtfyNotifier({
      baseUrl: settings.baseUrl,
      topic: settings.topic,
    });
  }

  if (
    settings.telegramBotToken === null ||
    settings.telegramBotToken === '' ||
    settings.telegramChatId === null ||
    settings.telegramChatId === ''
  ) {
    return noop(
      'telegram bot token or chat id missing — notifications disabled until configured',
    );
  }
  return createTelegramNotifier({
    botToken: settings.telegramBotToken,
    chatId: settings.telegramChatId,
  });
}

/**
 * The server adapter: masks secrets out of reads, rebuilds the notifier after
 * every write, and funnels test sends through the manager (which sanitizes
 * upstream errors).
 */
export function createNotificationAdapter(
  db: ReefDatabase,
  manager: NotificationManager,
): {
  getSettings: () => NotificationSettings;
  updateSettings: (
    partial: UpdateNotificationSettingsRequest,
  ) => NotificationSettings;
  test: () => Promise<{ ok: boolean; error?: string }>;
} {
  return {
    getSettings: () => maskNotificationSettings(db.getNotificationSettings()),
    updateSettings: (partial) => {
      const updated = db.updateNotificationSettings(partial);
      manager.configure();
      return maskNotificationSettings(updated);
    },
    test: () => manager.sendTest(),
  };
}

/**
 * Convenience bundle used by index.ts (and integration tests): manager +
 * notifier factory + server adapter in one shot.
 */
export function createNotificationLayer(db: ReefDatabase): {
  manager: NotificationManager;
  adapter: ReturnType<typeof createNotificationAdapter>;
} {
  const manager = createNotificationManager({
    getSettings: () => db.getNotificationSettings(),
    createNotifier: createNotifierFromSettings,
  });
  return { manager, adapter: createNotificationAdapter(db, manager) };
}
