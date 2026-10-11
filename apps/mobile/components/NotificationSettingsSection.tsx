import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_REPEAT_INTERVALS,
  type NotificationEventType,
  type NotificationRepeatInterval,
  type NotificationSettings,
  type UpdateNotificationSettingsRequest,
} from '@reef/shared';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  getNotificationSettings,
  sendTestNotification,
  updateNotificationSettings,
} from '@/src/api/client';
import {
  generateNtfyTopic,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_INTERVAL_LABELS,
} from '@/src/lib/notifications';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const SERVICES: { id: NotificationSettings['service']; label: string }[] = [
  { id: 'ntfy', label: 'ntfy' },
  { id: 'telegram', label: 'Telegram' },
];

const TELEGRAM_SETUP_HINT =
  'Create a bot via @BotFather, message it, then use the chat ID.';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Notifications settings section for the Settings screen. Secrets are
 * write-only: the server only reports hasBotToken/hasChatId, so empty token
 * inputs mean "keep what is stored" and erasing goes through the explicit
 * Remove actions (clearBotToken/clearChatId).
 *
 * Saves are explicit (one Save button, changed-fields-only) — the same
 * idiom as the device URL and system volume editors in Settings.
 */
export function NotificationSettingsSection({ baseUrl }: { baseUrl: string }) {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>(
    'loading',
  );
  const [loadError, setLoadError] = useState('');
  // Server snapshot used to diff against on Save. Null until first load.
  const [baseline, setBaseline] = useState<NotificationSettings | null>(null);
  // Working copy — toggles/intervals edit this optimistically; Save persists.
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [topic, setTopic] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [botTokenInput, setBotTokenInput] = useState('');
  const [chatIdInput, setChatIdInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const res = await getNotificationSettings(baseUrl);
      setBaseline(res.settings);
      setSettings(res.settings);
      setTopic(res.settings.topic);
      setServerUrl(res.settings.baseUrl);
      setBotTokenInput('');
      setChatIdInput('');
      setLoadState('ready');
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load notification settings'));
      setLoadState('error');
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
  }, [load]);

  const applyServerSettings = (next: NotificationSettings) => {
    setBaseline(next);
    setSettings(next);
    setTopic(next.topic);
    setServerUrl(next.baseUrl);
    setBotTokenInput('');
    setChatIdInput('');
  };

  const handleEnabledChange = (value: boolean) => {
    setTestResult(null);
    if (!settings) return;
    // First-time convenience: enabling with an empty topic suggests one
    // locally so the user isn't stuck inventing a topic before first save.
    if (value && settings.topic === '' && topic.trim() === '') {
      setTopic(generateNtfyTopic());
    }
    setSettings({ ...settings, enabled: value });
  };

  const handleServiceChange = (service: NotificationSettings['service']) => {
    setTestResult(null);
    if (settings) setSettings({ ...settings, service });
  };

  const handleEventToggle = (type: NotificationEventType, value: boolean) => {
    setTestResult(null);
    if (!settings) return;
    setSettings({
      ...settings,
      toggles: { ...settings.toggles, [type]: value },
    });
  };

  const handleIntervalChange = (
    type: NotificationEventType,
    interval: NotificationRepeatInterval,
  ) => {
    setTestResult(null);
    if (!settings) return;
    setSettings({
      ...settings,
      repeatIntervals: { ...settings.repeatIntervals, [type]: interval },
    });
  };

  const buildUpdateBody = (): UpdateNotificationSettingsRequest | null => {
    if (!settings || !baseline) return null;
    const body: UpdateNotificationSettingsRequest = {};
    if (settings.enabled !== baseline.enabled) body.enabled = settings.enabled;
    if (settings.service !== baseline.service) body.service = settings.service;
    const trimmedTopic = topic.trim();
    if (trimmedTopic !== baseline.topic) body.topic = trimmedTopic;
    const trimmedUrl = serverUrl.trim();
    if (trimmedUrl !== baseline.baseUrl) body.baseUrl = trimmedUrl;
    // Non-empty input replaces the stored secret; empty input means keep it
    // (never send botToken/chatId unless the user typed a value — sending an
    // empty string would clobber the stored secret server-side).
    if (botTokenInput.trim()) body.botToken = botTokenInput.trim();
    if (chatIdInput.trim()) body.chatId = chatIdInput.trim();
    const toggles: Partial<Record<NotificationEventType, boolean>> = {};
    for (const type of NOTIFICATION_EVENT_TYPES) {
      if (settings.toggles[type] !== baseline.toggles[type]) {
        toggles[type] = settings.toggles[type];
      }
    }
    if (Object.keys(toggles).length > 0) body.toggles = toggles;
    const repeatIntervals: Partial<
      Record<NotificationEventType, NotificationRepeatInterval>
    > = {};
    for (const type of NOTIFICATION_EVENT_TYPES) {
      if (settings.repeatIntervals[type] !== baseline.repeatIntervals[type]) {
        repeatIntervals[type] = settings.repeatIntervals[type];
      }
    }
    if (Object.keys(repeatIntervals).length > 0) {
      body.repeatIntervals = repeatIntervals;
    }
    return Object.keys(body).length > 0 ? body : null;
  };

  const handleSave = async () => {
    const body = buildUpdateBody();
    setTestResult(null);
    setSaveError('');
    if (!body) return; // Nothing changed.
    setSaving(true);
    try {
      const res = await updateNotificationSettings(baseUrl, body);
      applyServerSettings(res.settings);
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const handleClearSecret = async (
    kind: 'botToken' | 'chatId',
  ) => {
    setTestResult(null);
    setSaveError('');
    setSaving(true);
    try {
      const res = await updateNotificationSettings(
        baseUrl,
        kind === 'botToken' ? { clearBotToken: true } : { clearChatId: true },
      );
      applyServerSettings(res.settings);
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to remove'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    setSaveError('');
    setTesting(true);
    try {
      const res = await sendTestNotification(baseUrl);
      setTestResult(
        res.ok
          ? { ok: true, text: 'Test notification sent' }
          : { ok: false, text: res.error ?? 'Test notification failed' },
      );
    } catch (err) {
      setTestResult({
        ok: false,
        text: errorMessage(err, 'Test notification failed'),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <ThemedView style={styles.card}>
      <ThemedText style={styles.label}>Notifications</ThemedText>

      {loadState === 'loading' ? (
        <ThemedText style={styles.metric}>Loading…</ThemedText>
      ) : null}

      {loadState === 'error' ? (
        <>
          <ThemedText style={styles.errorText}>{loadError}</ThemedText>
          <Pressable
            accessibilityRole="button"
            style={styles.retryButton}
            onPress={load}>
            <ThemedText style={styles.retryButtonText}>Retry</ThemedText>
          </Pressable>
        </>
      ) : null}

      {loadState === 'ready' && settings ? (
        <>
          <ThemedView style={styles.toggleRow}>
            <ThemedText style={styles.bodyText}>Enable notifications</ThemedText>
            <Switch
              accessibilityLabel="Enable notifications"
              value={settings.enabled}
              onValueChange={handleEnabledChange}
              trackColor={{ false: Colors.slate, true: Colors.aqua }}
              thumbColor={settings.enabled ? Colors.pearl : Colors.titanium}
            />
          </ThemedView>

          <ThemedText style={styles.fieldLabel}>Service</ThemedText>
          <ThemedView style={styles.pillRow}>
            {SERVICES.map((svc) => {
              const selected = settings.service === svc.id;
              return (
                <Pressable
                  key={svc.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Service ${svc.label}`}
                  style={[styles.pill, selected && styles.pillSelected]}
                  onPress={() => handleServiceChange(svc.id)}>
                  <ThemedText
                    style={[styles.pillText, selected && styles.pillTextSelected]}>
                    {svc.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </ThemedView>

          {settings.service === 'ntfy' ? (
            <>
              <ThemedText style={styles.fieldLabel}>Topic</ThemedText>
              <ThemedView style={styles.inputRow}>
                <ThemedTextInput
                  style={[styles.input, styles.inputFlex]}
                  accessibilityLabel="Topic"
                  value={topic}
                  onChangeText={setTopic}
                  placeholder="sharlay-xxxxxxxx"
                  placeholderTextColor={Colors.slate}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable
                  accessibilityRole="button"
                  style={styles.generateButton}
                  onPress={() => setTopic(generateNtfyTopic())}>
                  <ThemedText style={styles.generateButtonText}>
                    Generate
                  </ThemedText>
                </Pressable>
              </ThemedView>
              <ThemedText style={styles.hintText}>
                Subscribe to this topic in the ntfy app to receive alerts.
              </ThemedText>

              <ThemedText style={styles.fieldLabel}>Server URL</ThemedText>
              <ThemedTextInput
                style={styles.input}
                accessibilityLabel="Server URL"
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="https://ntfy.sh"
                placeholderTextColor={Colors.slate}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </>
          ) : (
            <>
              <ThemedText style={styles.hintText}>{TELEGRAM_SETUP_HINT}</ThemedText>

              <ThemedText style={styles.fieldLabel}>Bot token</ThemedText>
              <ThemedTextInput
                style={styles.input}
                accessibilityLabel="Bot token"
                value={botTokenInput}
                onChangeText={setBotTokenInput}
                placeholder={
                  settings.hasBotToken ? 'Stored — enter to replace' : 'Bot token'
                }
                placeholderTextColor={Colors.slate}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <ThemedText style={styles.hintText}>
                From @BotFather — kept on the device, never shown again.
              </ThemedText>
              {settings.hasBotToken ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove bot token"
                  onPress={() => handleClearSecret('botToken')}
                  disabled={saving}>
                  <ThemedText style={styles.removeText}>Remove</ThemedText>
                </Pressable>
              ) : null}

              <ThemedText style={styles.fieldLabel}>Chat ID</ThemedText>
              <ThemedTextInput
                style={styles.input}
                accessibilityLabel="Chat ID"
                value={chatIdInput}
                onChangeText={setChatIdInput}
                placeholder={
                  settings.hasChatId ? 'Stored — enter to replace' : 'Chat ID'
                }
                placeholderTextColor={Colors.slate}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <ThemedText style={styles.hintText}>
                Your Telegram user or group ID.
              </ThemedText>
              {settings.hasChatId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove chat ID"
                  onPress={() => handleClearSecret('chatId')}
                  disabled={saving}>
                  <ThemedText style={styles.removeText}>Remove</ThemedText>
                </Pressable>
              ) : null}
            </>
          )}

          <ThemedText style={styles.fieldLabel}>Alert me about</ThemedText>
          {NOTIFICATION_EVENT_TYPES.map((type) => {
            const eventLabel = NOTIFICATION_EVENT_LABELS[type];
            const on = settings.toggles[type];
            return (
              <ThemedView key={type} style={styles.eventBlock}>
                <ThemedView style={styles.toggleRow}>
                  <ThemedText style={styles.bodyText}>{eventLabel}</ThemedText>
                  <Switch
                    accessibilityLabel={`${eventLabel} notifications`}
                    value={on}
                    onValueChange={(value) => handleEventToggle(type, value)}
                    trackColor={{ false: Colors.slate, true: Colors.aqua }}
                    thumbColor={on ? Colors.pearl : Colors.titanium}
                  />
                </ThemedView>
                <View style={styles.pillRow}>
                  {NOTIFICATION_REPEAT_INTERVALS.map((interval) => {
                    const intervalLabel = NOTIFICATION_INTERVAL_LABELS[interval];
                    const selected = settings.repeatIntervals[type] === interval;
                    return (
                      <Pressable
                        key={interval}
                        accessibilityRole="button"
                        accessibilityLabel={`${eventLabel} — ${intervalLabel}`}
                        accessibilityState={{ disabled: !on }}
                        style={[
                          styles.pill,
                          selected && styles.pillSelected,
                          !on && styles.disabledPill,
                        ]}
                        disabled={!on}
                        onPress={() => handleIntervalChange(type, interval)}>
                        <ThemedText
                          style={[
                            styles.pillText,
                            selected && styles.pillTextSelected,
                          ]}>
                          {intervalLabel}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              </ThemedView>
            );
          })}

          {saveError ? (
            <ThemedText style={styles.errorText}>{saveError}</ThemedText>
          ) : null}
          <Pressable
            accessibilityRole="button"
            style={[styles.button, saving && styles.disabledButton]}
            onPress={handleSave}
            disabled={saving}>
            <ThemedText style={styles.buttonText}>
              {saving ? 'Saving…' : 'Save'}
            </ThemedText>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            style={[styles.secondaryButton, testing && styles.disabledButton]}
            onPress={handleTest}
            disabled={testing}>
            <ThemedText style={styles.secondaryButtonText}>
              {testing ? 'Sending…' : 'Send test notification'}
            </ThemedText>
          </Pressable>
          {testResult ? (
            <ThemedText
              style={testResult.ok ? styles.successText : styles.errorText}>
              {testResult.text}
            </ThemedText>
          ) : null}
        </>
      ) : null}
    </ThemedView>
  );
}

export default NotificationSettingsSection;

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  label: {
    ...Typography.body,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
  metric: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.md,
  },
  bodyText: {
    ...Typography.body,
    color: Colors.titanium,
    flex: 1,
  },
  fieldLabel: {
    ...Typography.small,
    color: Colors.pearl,
    marginBottom: Spacing.sm,
    marginTop: Spacing.sm,
  },
  hintText: {
    ...Typography.small,
    color: Colors.slate,
    marginBottom: Spacing.sm,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  input: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.3)',
    backgroundColor: Colors.midnight,
    color: Colors.pearl,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.body.fontSize,
    marginBottom: Spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  inputFlex: {
    flex: 1,
  },
  generateButton: {
    backgroundColor: Colors.aqua,
    paddingHorizontal: Spacing.md,
    height: 48,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  generateButtonText: {
    ...Typography.body,
    color: Colors.obsidian,
    fontWeight: '600',
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  pill: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.3)',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  pillSelected: {
    backgroundColor: Colors.aqua,
    borderColor: Colors.aqua,
  },
  pillText: {
    ...Typography.small,
    color: Colors.titanium,
  },
  pillTextSelected: {
    color: Colors.obsidian,
    fontWeight: '600',
  },
  disabledPill: {
    opacity: 0.4,
  },
  disabledButton: {
    opacity: 0.4,
  },
  eventBlock: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.midnight,
  },
  button: {
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  buttonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  secondaryButton: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.aqua,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  secondaryButtonText: {
    ...Typography.body,
    color: Colors.aqua,
  },
  retryButton: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.aqua,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  retryButtonText: {
    ...Typography.body,
    color: Colors.aqua,
  },
  removeText: {
    ...Typography.small,
    color: Colors.danger,
    marginBottom: Spacing.sm,
  },
  errorText: {
    ...Typography.body,
    color: Colors.danger,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
  successText: {
    ...Typography.body,
    color: Colors.success,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
});
