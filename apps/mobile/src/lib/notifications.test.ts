import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_REPEAT_INTERVALS,
} from '@reef/shared';

import {
  defaultNotificationSettings,
  generateNtfyTopic,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_INTERVAL_LABELS,
} from './notifications';

describe('generateNtfyTopic', () => {
  it('produces a sharlay- prefix followed by 8 alphanumeric chars', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateNtfyTopic()).toMatch(/^sharlay-[a-z0-9]{8}$/);
    }
  });

  it('generates distinct topics across calls', () => {
    const topics = new Set(Array.from({ length: 20 }, () => generateNtfyTopic()));
    expect(topics.size).toBeGreaterThan(1);
  });
});

describe('NOTIFICATION_EVENT_LABELS', () => {
  it('covers every event type in NOTIFICATION_EVENT_TYPES', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(typeof NOTIFICATION_EVENT_LABELS[type]).toBe('string');
      expect(NOTIFICATION_EVENT_LABELS[type].length).toBeGreaterThan(0);
    }
    expect(Object.keys(NOTIFICATION_EVENT_LABELS).sort()).toEqual(
      [...NOTIFICATION_EVENT_TYPES].sort(),
    );
  });

  it('has the expected human labels', () => {
    expect(NOTIFICATION_EVENT_LABELS).toEqual({
      dose_failed: 'Dose failed',
      dose_interrupted: 'Dose interrupted',
      container_low: 'Container low',
      audit_finding: 'Audit findings',
      schedule_silent: 'Schedule silent',
    });
  });
});

describe('NOTIFICATION_INTERVAL_LABELS', () => {
  it('covers every interval in NOTIFICATION_REPEAT_INTERVALS', () => {
    for (const interval of NOTIFICATION_REPEAT_INTERVALS) {
      expect(typeof NOTIFICATION_INTERVAL_LABELS[interval]).toBe('string');
      expect(NOTIFICATION_INTERVAL_LABELS[interval].length).toBeGreaterThan(0);
    }
    expect(Object.keys(NOTIFICATION_INTERVAL_LABELS).sort()).toEqual(
      [...NOTIFICATION_REPEAT_INTERVALS].sort(),
    );
  });

  it('has the expected labels', () => {
    expect(NOTIFICATION_INTERVAL_LABELS).toEqual({
      off: 'Off',
      '30m': '30 min',
      '1h': '1 hour',
      '2h': '2 hours',
      '6h': '6 hours',
      '24h': '24 hours',
    });
  });
});

describe('defaultNotificationSettings', () => {
  it('matches the documented defaults', () => {
    expect(defaultNotificationSettings()).toEqual({
      enabled: false,
      service: 'ntfy',
      topic: '',
      baseUrl: 'https://ntfy.sh',
      hasBotToken: false,
      hasChatId: false,
      toggles: {
        dose_failed: true,
        dose_interrupted: true,
        container_low: true,
        audit_finding: true,
        schedule_silent: true,
      },
      repeatIntervals: {
        dose_failed: '2h',
        dose_interrupted: '2h',
        container_low: '2h',
        audit_finding: '24h',
        schedule_silent: 'off',
      },
    });
  });

  it('returns a fresh object each call (no shared mutation)', () => {
    const a = defaultNotificationSettings();
    const b = defaultNotificationSettings();
    a.toggles.dose_failed = false;
    a.repeatIntervals.container_low = 'off';
    expect(b.toggles.dose_failed).toBe(true);
    expect(b.repeatIntervals.container_low).toBe('2h');
  });
});
