import type {
  NotificationEventType,
  NotificationRepeatInterval,
  NotificationSettings,
} from '@reef/shared';
import type { NotificationPriority, Notifier } from './notifier.js';

/**
 * Internal settings shape: everything the API exposes PLUS the raw secrets.
 * Only the DB layer and the notifier factory ever see this; the API mask
 * (hasBotToken/hasChatId) is built by maskNotificationSettings and the
 * secret columns never reach logs or responses.
 */
export type FullNotificationSettings = Omit<
  NotificationSettings,
  'hasBotToken' | 'hasChatId'
> & {
  telegramBotToken: string | null;
  telegramChatId: string | null;
};

/** Per-event reminder cadence for a freshly configured device. */
export const DEFAULT_REPEAT_INTERVALS: Record<
  NotificationEventType,
  NotificationRepeatInterval
> = {
  dose_failed: '2h',
  dose_interrupted: '2h',
  container_low: '2h',
  audit_finding: '24h',
  schedule_silent: 'off',
};

/** Repeat interval → milliseconds. 'off' = null (no reminders). */
export const REPEAT_INTERVAL_MS: Record<
  NotificationRepeatInterval,
  number | null
> = {
  off: null,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

export interface NotificationManager {
  /** Re-read settings and rebuild the notifier (after PUT, at boot). */
  configure(): void;
  /**
   * State-change discipline per (eventType, key): first call for a pair
   * sends immediately and marks the incident active; further calls re-send
   * only when the event's repeat interval has elapsed since the last send.
   * Never throws — called from dosing paths.
   */
  notifyIncident(
    eventType: NotificationEventType,
    key: string,
    title: string,
    body: string,
    priority: NotificationPriority,
  ): void;
  /**
   * Edge-triggered wrapper for persistent conditions: false clears the
   * incident; true sends on the false→true edge then reminders at the
   * configured interval. Never throws.
   */
  evaluateCondition(
    eventType: NotificationEventType,
    key: string,
    condition: boolean,
    makeMessage: () => { title: string; body: string; priority: NotificationPriority },
  ): void;
  /** Mark no active incident for the pair (e.g. a dose completed again). */
  clear(eventType: NotificationEventType, key: string): void;
  /** Real send of a test message; all errors are caught and sanitized. */
  sendTest(): Promise<{ ok: boolean; error?: string }>;
}

export interface CreateNotificationManagerOptions {
  getSettings: () => FullNotificationSettings;
  createNotifier: (settings: FullNotificationSettings) => Notifier;
  /** Millisecond clock, injectable for tests. */
  now?: () => number;
  logger?: (message: string) => void;
}

/** Strip the API-masked view out of the full internal settings shape. */
export function maskNotificationSettings(
  full: FullNotificationSettings,
): NotificationSettings {
  return {
    enabled: full.enabled,
    service: full.service,
    topic: full.topic,
    baseUrl: full.baseUrl,
    hasBotToken: full.telegramBotToken !== null && full.telegramBotToken !== '',
    hasChatId: full.telegramChatId !== null && full.telegramChatId !== '',
    toggles: { ...full.toggles },
    repeatIntervals: { ...full.repeatIntervals },
  };
}

interface ActiveIncident {
  lastSentAt: number;
}

export function createNotificationManager(
  options: CreateNotificationManagerOptions,
): NotificationManager {
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? ((message: string) => console.warn(message));

  let settings: FullNotificationSettings | null = null;
  let notifier: Notifier = {
    async send() {
      // No notifier configured yet — sends are silent no-ops.
    },
  };

  /** Active incidents keyed `${eventType}:${key}`. */
  const incidents = new Map<string, ActiveIncident>();

  const incidentKey = (eventType: NotificationEventType, key: string) =>
    `${eventType}:${key}`;

  const configure = (): void => {
    settings = options.getSettings();
    try {
      notifier = options.createNotifier(settings);
    } catch (error) {
      log(
        `[notifications] notifier setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      notifier = {
        async send() {
          // Broken configuration must never break dosing paths.
        },
      };
    }
  };

  const isArmed = (eventType: NotificationEventType): boolean =>
    settings !== null && settings.enabled && settings.toggles[eventType];

  const fireAndForget = (
    eventType: NotificationEventType,
    key: string,
    title: string,
    body: string,
    priority: NotificationPriority,
  ): void => {
    void Promise.resolve(notifier.send(title, body, priority)).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`[notifications] failed to send ${eventType}/${key}: ${message}`);
      },
    );
  };

  const notifyIncident: NotificationManager['notifyIncident'] = (
    eventType,
    key,
    title,
    body,
    priority,
  ) => {
    try {
      if (!isArmed(eventType)) return;
      const s = settings!;
      const mapKey = incidentKey(eventType, key);
      const active = incidents.get(mapKey);
      const nowMs = now();

      if (active === undefined) {
        incidents.set(mapKey, { lastSentAt: nowMs });
        fireAndForget(eventType, key, title, body, priority);
        return;
      }

      const intervalMs = REPEAT_INTERVAL_MS[s.repeatIntervals[eventType]];
      if (intervalMs !== null && nowMs - active.lastSentAt >= intervalMs) {
        active.lastSentAt = nowMs;
        fireAndForget(eventType, key, title, body, priority);
      }
    } catch {
      // The manager must NEVER throw into a dosing path.
    }
  };

  const evaluateCondition: NotificationManager['evaluateCondition'] = (
    eventType,
    key,
    condition,
    makeMessage,
  ) => {
    try {
      if (!condition) {
        incidents.delete(incidentKey(eventType, key));
        return;
      }
      if (!isArmed(eventType)) return;
      const s = settings!;
      const mapKey = incidentKey(eventType, key);
      const active = incidents.get(mapKey);
      const nowMs = now();

      let due = false;
      if (active === undefined) {
        incidents.set(mapKey, { lastSentAt: nowMs });
        due = true;
      } else {
        const intervalMs = REPEAT_INTERVAL_MS[s.repeatIntervals[eventType]];
        if (intervalMs !== null && nowMs - active.lastSentAt >= intervalMs) {
          active.lastSentAt = nowMs;
          due = true;
        }
      }
      if (due) {
        const message = makeMessage();
        fireAndForget(eventType, key, message.title, message.body, message.priority);
      }
    } catch {
      // Never throw — the sweeper calls this on a timer.
    }
  };

  const clear: NotificationManager['clear'] = (eventType, key) => {
    incidents.delete(incidentKey(eventType, key));
  };

  const sendTest = async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const s = settings;
      const incomplete =
        s === null ||
        !s.enabled ||
        (s.service === 'ntfy' && s.topic.trim() === '') ||
        (s.service === 'telegram' &&
          (s.telegramBotToken === null ||
            s.telegramBotToken === '' ||
            s.telegramChatId === null ||
            s.telegramChatId === ''));
      if (incomplete) {
        return { ok: false, error: 'Notifications not configured' };
      }
      await notifier.send('SHARLAY', 'Test notification from SHARLAY', 'default');
      return { ok: true };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // Sanitize: an upstream that echoes our credentials must not leak
      // them into the API response.
      if (
        settings !== null &&
        ((settings.telegramBotToken !== null &&
          settings.telegramBotToken !== '' &&
          message.includes(settings.telegramBotToken)) ||
          (settings.telegramChatId !== null &&
            settings.telegramChatId !== '' &&
            message.includes(settings.telegramChatId)))
      ) {
        message = 'upstream error';
      }
      return { ok: false, error: message };
    }
  };

  // Build the notifier immediately so the manager is usable from boot even
  // if configure() is never called explicitly.
  configure();

  return { configure, notifyIncident, evaluateCondition, clear, sendTest };
}
