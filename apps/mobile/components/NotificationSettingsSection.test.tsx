import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { resetAllMocks, setDimensions } from 'vitest-native/helpers';
import type { NotificationSettings } from '@reef/shared';

import { defaultNotificationSettings } from '@/src/lib/notifications';
import { NotificationSettingsSection } from './NotificationSettingsSection';

vi.mock('@/src/api/client', () => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
  sendTestNotification: vi.fn(),
}));

import {
  getNotificationSettings,
  sendTestNotification,
  updateNotificationSettings,
} from '@/src/api/client';

const BASE_URL = 'http://192.168.0.33:8000';

function makeSettings(
  overrides: Partial<NotificationSettings> = {},
): NotificationSettings {
  return { ...defaultNotificationSettings(), ...overrides };
}

function mockLoaded(settings: NotificationSettings) {
  vi.mocked(getNotificationSettings).mockResolvedValue({ settings });
  vi.mocked(updateNotificationSettings).mockImplementation(async (_url, body) => {
    // Minimal server behaviour for the flows under test.
    const next = {
      ...settings,
      ...('botToken' in body ? { hasBotToken: true } : null),
      ...('chatId' in body ? { hasChatId: true } : null),
      ...(body.clearBotToken ? { hasBotToken: false } : null),
      ...(body.clearChatId ? { hasChatId: false } : null),
    };
    return { settings: next };
  });
}

async function renderSection(settings: NotificationSettings = makeSettings()) {
  mockLoaded(settings);
  render(<NotificationSettingsSection baseUrl={BASE_URL} />);
  await screen.findByLabelText('Enable notifications');
}

function eventInterval(event: string, interval: string) {
  return screen.getByLabelText(`${event} — ${interval}`);
}

beforeEach(() => {
  resetAllMocks();
  setDimensions({ width: 390, height: 800, scale: 1, fontScale: 1 });
});

describe('NotificationSettingsSection — rendering', () => {
  it('renders the enable toggle, service picker, and all five event rows', async () => {
    await renderSection();

    expect(screen.getByLabelText('Enable notifications')).toBeTruthy();
    expect(screen.getByLabelText('Service ntfy')).toBeTruthy();
    expect(screen.getByLabelText('Service Telegram')).toBeTruthy();

    for (const label of [
      'Dose failed',
      'Dose interrupted',
      'Container low',
      'Audit findings',
      'Schedule silent',
    ]) {
      expect(screen.getByLabelText(`${label} notifications`)).toBeTruthy();
      for (const interval of [
        'Off',
        '30 min',
        '1 hour',
        '2 hours',
        '6 hours',
        '24 hours',
      ]) {
        expect(eventInterval(label, interval)).toBeTruthy();
      }
    }
  });

  it('shows ntfy topic + server URL fields by default', async () => {
    await renderSection();
    expect(screen.getByLabelText('Topic')).toBeTruthy();
    expect(screen.getByLabelText('Server URL')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy();
  });
});

describe('NotificationSettingsSection — per-event intervals', () => {
  it('disables the interval selector when the event toggle is off', async () => {
    await renderSection(
      makeSettings({
        toggles: { ...defaultNotificationSettings().toggles, dose_failed: false },
      }),
    );

    expect(eventInterval('Dose failed', '30 min').props.accessibilityState).toEqual(
      { disabled: true },
    );
    expect(
      eventInterval('Dose interrupted', '30 min').props.accessibilityState,
    ).toEqual({ disabled: false });
  });

  it('flips the selector enabled state when the event toggle changes', async () => {
    await renderSection();

    fireEvent(
      screen.getByLabelText('Dose failed notifications'),
      'onValueChange',
      false,
    );
    expect(eventInterval('Dose failed', '30 min').props.accessibilityState).toEqual(
      { disabled: true },
    );

    fireEvent(
      screen.getByLabelText('Dose failed notifications'),
      'onValueChange',
      true,
    );
    expect(eventInterval('Dose failed', '30 min').props.accessibilityState).toEqual(
      { disabled: false },
    );
  });

  it('an interval pill cannot be pressed while its event is off', async () => {
    await renderSection(
      makeSettings({
        toggles: { ...defaultNotificationSettings().toggles, container_low: false },
      }),
    );

    expect(() =>
      fireEvent.press(eventInterval('Container low', '1 hour')),
    ).not.toThrow();
    // Still disabled — the press was a no-op.
    expect(eventInterval('Container low', '1 hour').props.accessibilityState).toEqual(
      { disabled: true },
    );
  });
});

describe('NotificationSettingsSection — service switching', () => {
  it('shows Telegram token/chat ID fields and the @BotFather hint', async () => {
    await renderSection();
    fireEvent.press(screen.getByLabelText('Service Telegram'));

    expect(screen.getByLabelText('Bot token')).toBeTruthy();
    expect(screen.getByLabelText('Chat ID')).toBeTruthy();
    expect(
      screen.getByText(
        'Create a bot via @BotFather, message it, then use the chat ID.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Topic')).toBeNull();
  });

  it('returns to ntfy topic + URL fields when switching back', async () => {
    await renderSection();
    fireEvent.press(screen.getByLabelText('Service Telegram'));
    fireEvent.press(screen.getByLabelText('Service ntfy'));

    expect(screen.getByLabelText('Topic')).toBeTruthy();
    expect(screen.getByLabelText('Server URL')).toBeTruthy();
    expect(screen.queryByLabelText('Bot token')).toBeNull();
  });
});

describe('NotificationSettingsSection — topic generation', () => {
  it('Generate fills a sharlay-xxxxxxxx topic', async () => {
    await renderSection();
    fireEvent.press(screen.getByRole('button', { name: 'Generate' }));

    const topic = screen.getByLabelText('Topic').props.value as string;
    expect(topic).toMatch(/^sharlay-[a-z0-9]{8}$/);
  });

  it('prefills a generated topic the first time notifications are enabled', async () => {
    await renderSection();
    fireEvent(screen.getByLabelText('Enable notifications'), 'onValueChange', true);

    const topic = screen.getByLabelText('Topic').props.value as string;
    expect(topic).toMatch(/^sharlay-[a-z0-9]{8}$/);
  });
});

describe('NotificationSettingsSection — save', () => {
  it('sends only the changed fields', async () => {
    await renderSection();

    fireEvent.changeText(screen.getByLabelText('Topic'), 'sharlay-mytopic');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith(BASE_URL, {
        topic: 'sharlay-mytopic',
      }),
    );
  });

  it('sends only the changed toggle when one event is switched off', async () => {
    await renderSection();

    fireEvent(
      screen.getByLabelText('Audit findings notifications'),
      'onValueChange',
      false,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith(BASE_URL, {
        toggles: { audit_finding: false },
      }),
    );
  });

  it('does not PUT at all when nothing changed', async () => {
    await renderSection();
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    // Let any microtask flush.
    await waitFor(() => expect(updateNotificationSettings).not.toHaveBeenCalled());
  });

  it('never includes an empty bot token in the PUT body', async () => {
    await renderSection();
    fireEvent.press(screen.getByLabelText('Service Telegram'));
    fireEvent.changeText(screen.getByLabelText('Chat ID'), '12345');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith(BASE_URL, {
        service: 'telegram',
        chatId: '12345',
      }),
    );
    const body = vi.mocked(updateNotificationSettings).mock.calls[0][1];
    expect(body).not.toHaveProperty('botToken');
  });

  it('sends a typed bot token on save and clears the input afterwards', async () => {
    await renderSection(
      makeSettings({ service: 'telegram', hasBotToken: false }),
    );
    fireEvent.changeText(screen.getByLabelText('Bot token'), '123:new-token');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith(BASE_URL, {
        botToken: '123:new-token',
      }),
    );
    expect(screen.getByLabelText('Bot token').props.value).toBe('');
  });

  it('sends clearBotToken from the explicit Remove action', async () => {
    await renderSection(
      makeSettings({ service: 'telegram', hasBotToken: true, hasChatId: true }),
    );

    fireEvent.press(screen.getByLabelText('Remove bot token'));
    await waitFor(() =>
      expect(updateNotificationSettings).toHaveBeenCalledWith(BASE_URL, {
        clearBotToken: true,
      }),
    );
  });
});

describe('NotificationSettingsSection — test notification', () => {
  it('shows success text when the server confirms the send', async () => {
    await renderSection();
    vi.mocked(sendTestNotification).mockResolvedValue({ ok: true });

    fireEvent.press(screen.getByRole('button', { name: 'Send test notification' }));

    expect(await screen.findByText('Test notification sent')).toBeTruthy();
  });

  it('shows the server error message when the send fails', async () => {
    await renderSection();
    vi.mocked(sendTestNotification).mockResolvedValue({
      ok: false,
      error: 'ntfy server unreachable',
    });

    fireEvent.press(screen.getByRole('button', { name: 'Send test notification' }));

    expect(await screen.findByText('ntfy server unreachable')).toBeTruthy();
  });
});

describe('NotificationSettingsSection — secret masking', () => {
  it('shows the masked placeholder and a Remove affordance, never a token value', async () => {
    const fakeToken = '123456:ABCDEF-FAKE-TOKEN-VALUE';
    await renderSection(
      makeSettings({ service: 'telegram', hasBotToken: true, hasChatId: true }),
    );

    expect(screen.getByLabelText('Bot token').props.placeholder).toBe(
      'Stored — enter to replace',
    );
    expect(screen.getByLabelText('Chat ID').props.placeholder).toBe(
      'Stored — enter to replace',
    );
    expect(screen.getByLabelText('Remove bot token')).toBeTruthy();
    expect(screen.getByLabelText('Remove chat ID')).toBeTruthy();
    // The secret value is write-only server-side and must not appear anywhere.
    expect(screen.queryByText(fakeToken)).toBeNull();
    expect(screen.queryAllByDisplayValue(fakeToken)).toHaveLength(0);
  });
});
