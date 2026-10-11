import { describe, expect, it, vi } from 'vitest';
import type { NotificationEventType } from '@reef/shared';
import {
  createNotificationManager,
  DEFAULT_REPEAT_INTERVALS,
  maskNotificationSettings,
  REPEAT_INTERVAL_MS,
  type FullNotificationSettings,
} from '../src/notifications.js';
import type { Notifier } from '../src/notifier.js';

const ALL_EVENTS: NotificationEventType[] = [
  'dose_failed',
  'dose_interrupted',
  'container_low',
  'audit_finding',
  'schedule_silent',
];

function makeSettings(
  overrides: Partial<FullNotificationSettings> = {},
): FullNotificationSettings {
  return {
    enabled: true,
    service: 'ntfy',
    topic: 'reef',
    baseUrl: 'https://ntfy.sh',
    telegramBotToken: null,
    telegramChatId: null,
    toggles: {
      dose_failed: true,
      dose_interrupted: true,
      container_low: true,
      audit_finding: true,
      schedule_silent: true,
    },
    repeatIntervals: { ...DEFAULT_REPEAT_INTERVALS },
    ...overrides,
  };
}

interface Sent {
  title: string;
  body: string;
  priority: string;
}

function createHarness(options: {
  settings: FullNotificationSettings;
  now?: () => number;
  notifier?: Notifier;
}): {
  sent: Sent[];
  manager: ReturnType<typeof createNotificationManager>;
  warn: ReturnType<typeof vi.fn>;
} {
  const sent: Sent[] = [];
  const warn = vi.fn();
  const notifier: Notifier =
    options.notifier ??
    {
      async send(title, body, priority) {
        sent.push({ title, body, priority });
      },
    };
  const manager = createNotificationManager({
    getSettings: () => options.settings,
    createNotifier: () => notifier,
    now: options.now,
    logger: warn,
  });
  return { sent, manager, warn };
}

describe('createNotificationManager', () => {
  it('sends the first incident immediately and suppresses an immediate repeat', () => {
    let t = 1_000_000;
    const { sent, manager } = createHarness({
      settings: makeSettings(),
      now: () => t,
    });

    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');

    expect(sent).toHaveLength(1);
  });

  it('sends a reminder once the configured interval elapses', () => {
    let t = 0;
    const { sent, manager } = createHarness({
      settings: makeSettings(),
      now: () => t,
    });

    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(1);

    // 2h default interval: 1 ms short — no reminder.
    t = REPEAT_INTERVAL_MS['2h']! - 1;
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(1);

    // Interval elapsed — reminder fires, exactly once.
    t = REPEAT_INTERVAL_MS['2h']!;
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(2);
    t = REPEAT_INTERVAL_MS['2h']! * 1.5;
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(2);

    // Next reminder only after another full interval from the last send.
    t = REPEAT_INTERVAL_MS['2h']! * 2;
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(3);
  });

  it('clear() re-arms the incident so the next notify fires immediately', () => {
    const { sent, manager } = createHarness({
      settings: makeSettings(),
      now: () => 0,
    });

    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    manager.clear('dose_failed', 'alk');
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');

    expect(sent).toHaveLength(2);
  });

  it('honours per-event repeat intervals independently', () => {
    let t = 0;
    const settings = makeSettings({
      repeatIntervals: {
        ...DEFAULT_REPEAT_INTERVALS,
        dose_failed: '30m',
        container_low: '24h',
      },
    });
    const { sent, manager } = createHarness({ settings, now: () => t });

    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    manager.notifyIncident('container_low', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(2);

    // After 1h: dose_failed (30m) reminds, container_low (24h) stays quiet.
    t = REPEAT_INTERVAL_MS['1h']!;
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    manager.notifyIncident('container_low', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(3);

    // Different keys of the same event type are fully independent.
    manager.notifyIncident('dose_failed', 'ca', 'T', 'B', 'high');
    expect(sent).toHaveLength(4);
  });

  it('does not send when the event toggle is off or notifications are disabled', () => {
    const toggledOff = makeSettings({
      toggles: { ...makeSettings().toggles, dose_failed: false },
    });
    const a = createHarness({ settings: toggledOff, now: () => 0 });
    a.manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(a.sent).toHaveLength(0);

    const disabled = makeSettings({ enabled: false });
    const b = createHarness({ settings: disabled, now: () => 0 });
    b.manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(b.sent).toHaveLength(0);
  });

  it('swallows notifier rejections, logs a warning, and never throws', async () => {
    const notifier: Notifier = {
      async send() {
        throw new Error('upstream exploded');
      },
    };
    const { manager, warn } = createHarness({
      settings: makeSettings(),
      now: () => 0,
      notifier,
    });

    expect(() =>
      manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high'),
    ).not.toThrow();

    // The send is fire-and-forget: flush microtasks so the rejection lands.
    await Promise.resolve();
    await Promise.resolve();

    // The incident is still marked active: the failure did not corrupt state.
    expect(warn).toHaveBeenCalledWith(
      '[notifications] failed to send dose_failed/alk: upstream exploded',
    );
  });

  it('evaluateCondition fires on the false→true edge, reminds while true, clears on true→false', () => {
    let t = 0;
    const { sent, manager } = createHarness({
      settings: makeSettings(),
      now: () => t,
    });
    const condition = { low: false };
    const evaluate = () =>
      manager.evaluateCondition(
        'container_low',
        'alk',
        condition.low,
        () => ({ title: 'LOW', body: 'B', priority: 'high' }),
      );

    evaluate();
    expect(sent).toHaveLength(0);

    condition.low = true;
    evaluate(); // edge → immediate send
    expect(sent).toHaveLength(1);

    evaluate(); // still true, interval not elapsed
    expect(sent).toHaveLength(1);

    t = REPEAT_INTERVAL_MS['2h']!; // reminder
    evaluate();
    expect(sent).toHaveLength(2);

    condition.low = false; // clear
    evaluate();
    expect(sent).toHaveLength(2);

    condition.low = true; // re-crossing fires immediately again
    evaluate();
    expect(sent).toHaveLength(3);
  });

  it('evaluateCondition is a no-op while the event toggle is off', () => {
    const settings = makeSettings({
      toggles: { ...makeSettings().toggles, audit_finding: false },
    });
    const { sent, manager } = createHarness({ settings, now: () => 0 });

    manager.evaluateCondition('audit_finding', 'audit', true, () => ({
      title: 'T',
      body: 'B',
      priority: 'default',
    }));
    expect(sent).toHaveLength(0);
  });

  describe('sendTest', () => {
    it('returns ok:true and sends the fixed test message through the notifier', async () => {
      const { sent, manager } = createHarness({
        settings: makeSettings(),
        now: () => 0,
      });

      const result = await manager.sendTest();

      expect(result).toEqual({ ok: true });
      expect(sent).toEqual([
        {
          title: 'SHARLAY',
          body: 'Test notification from SHARLAY',
          priority: 'default',
        },
      ]);
    });

    it('returns "Notifications not configured" without throwing when disabled or incomplete', async () => {
      const disabled = createHarness({
        settings: makeSettings({ enabled: false }),
        now: () => 0,
      });
      expect(await disabled.manager.sendTest()).toEqual({
        ok: false,
        error: 'Notifications not configured',
      });

      const noTopic = createHarness({
        settings: makeSettings({ topic: '' }),
        now: () => 0,
      });
      expect(await noTopic.manager.sendTest()).toEqual({
        ok: false,
        error: 'Notifications not configured',
      });

      const telegramMissing = createHarness({
        settings: makeSettings({
          service: 'telegram',
          telegramBotToken: null,
          telegramChatId: '1',
        }),
        now: () => 0,
      });
      expect(await telegramMissing.manager.sendTest()).toEqual({
        ok: false,
        error: 'Notifications not configured',
      });
    });

    it('catches upstream errors and strips anything resembling the token', async () => {
      const TOKEN = 'leaked-bot-token-value';
      const notifier: Notifier = {
        async send() {
          throw new Error(`upstream rejected token ${TOKEN}`);
        },
      };
      const { manager } = createHarness({
        settings: makeSettings({
          service: 'telegram',
          telegramBotToken: TOKEN,
          telegramChatId: '99',
        }),
        now: () => 0,
        notifier,
      });

      const result = await manager.sendTest();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('upstream error');
      expect(result.error).not.toContain(TOKEN);
    });

    it('passes through a sanitized upstream error message', async () => {
      const notifier: Notifier = {
        async send() {
          throw new Error('Bad Request: chat not found');
        },
      };
      const { manager } = createHarness({
        settings: makeSettings({
          service: 'telegram',
          telegramBotToken: 'tok',
          telegramChatId: '99',
        }),
        now: () => 0,
        notifier,
      });

      expect(await manager.sendTest()).toEqual({
        ok: false,
        error: 'Bad Request: chat not found',
      });
    });
  });

  it('configure() re-reads settings and rebuilds the notifier', () => {
    let settings = makeSettings();
    const sent: Sent[] = [];
    let warnCount = 0;
    const manager = createNotificationManager({
      getSettings: () => settings,
      createNotifier: () => ({
        async send(title, body, priority) {
          sent.push({ title, body, priority });
        },
      }),
      now: () => 0,
      logger: () => warnCount++,
    });

    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(1);

    // Flip the toggle and re-configure: the same incident must go quiet.
    settings = makeSettings({
      toggles: { ...settings.toggles, dose_failed: false },
    });
    manager.configure();
    manager.clear('dose_failed', 'alk');
    manager.notifyIncident('dose_failed', 'alk', 'T', 'B', 'high');
    expect(sent).toHaveLength(1);
  });
});

describe('maskNotificationSettings', () => {
  it('replaces secrets with booleans and keeps everything else', () => {
    const full = makeSettings({
      enabled: true,
      telegramBotToken: 'tok',
      telegramChatId: 'chat',
    });
    const masked = maskNotificationSettings(full);

    expect(masked.hasBotToken).toBe(true);
    expect(masked.hasChatId).toBe(true);
    expect(JSON.stringify(masked)).not.toContain('tok');
    expect(JSON.stringify(masked)).not.toContain('chat');
    expect(masked.topic).toBe('reef');
    expect(masked.enabled).toBe(true);
    for (const event of ALL_EVENTS) {
      expect(masked.toggles[event]).toBe(true);
      expect(masked.repeatIntervals[event]).toBe(
        DEFAULT_REPEAT_INTERVALS[event],
      );
    }
  });
});
