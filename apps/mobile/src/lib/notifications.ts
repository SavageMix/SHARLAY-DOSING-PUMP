import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_REPEAT_INTERVALS,
  type NotificationEventType,
  type NotificationRepeatInterval,
  type NotificationSettings,
} from '@reef/shared';

/**
 * Pure helpers for the Notifications settings section.
 * The device re-validates on PUT /api/notifications/settings; these exist so
 * defaults and labels are consistent and testable client-side.
 */

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  dose_failed: 'Dose failed',
  dose_interrupted: 'Dose interrupted',
  container_low: 'Container low',
  audit_finding: 'Audit findings',
  schedule_silent: 'Schedule silent',
};

export const NOTIFICATION_INTERVAL_LABELS: Record<
  NotificationRepeatInterval,
  string
> = {
  off: 'Off',
  '30m': '30 min',
  '1h': '1 hour',
  '2h': '2 hours',
  '6h': '6 hours',
  '24h': '24 hours',
};

const TOPIC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TOPIC_LENGTH = 8;

/**
 * Random ntfy topic suffix. Math.random is fine here: the topic is
 * convenience-obfuscation (unlisted topics on a public server), NOT a
 * security boundary — anyone the topic is shared with gets full access.
 */
export function generateNtfyTopic(): string {
  let suffix = '';
  for (let i = 0; i < TOPIC_LENGTH; i++) {
    suffix += TOPIC_ALPHABET[Math.floor(Math.random() * TOPIC_ALPHABET.length)];
  }
  return `sharlay-${suffix}`;
}

export function defaultNotificationSettings(): NotificationSettings {
  return {
    enabled: false,
    service: 'ntfy',
    topic: '',
    baseUrl: 'https://ntfy.sh',
    hasBotToken: false,
    hasChatId: false,
    toggles: Object.fromEntries(
      NOTIFICATION_EVENT_TYPES.map((t) => [t, true]),
    ) as Record<NotificationEventType, boolean>,
    repeatIntervals: {
      dose_failed: '2h',
      dose_interrupted: '2h',
      container_low: '2h',
      audit_finding: '24h',
      schedule_silent: 'off',
    },
  };
}
