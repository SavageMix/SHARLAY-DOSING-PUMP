import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  clearDeviceBaseUrl,
  getDeviceBaseUrl,
  setDeviceBaseUrl,
} from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

export default function SettingsScreen() {
  const router = useRouter();
  const [baseUrl, setBaseUrlState] = useState('');
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) {
          setSavedUrl(url);
          setBaseUrlState(url ?? '');
        }
      });
      return () => { mounted = false; };
    }, [])
  );

  const handleSave = async () => {
    try {
      await setDeviceBaseUrl(baseUrl.trim());
      setSavedUrl(baseUrl.trim());
      setMessage('Saved');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleReset = async () => {
    await clearDeviceBaseUrl();
    setSavedUrl(null);
    setBaseUrlState('');
    setMessage('Cleared');
    router.replace('/');
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.header}>Settings</ThemedText>

      <ThemedView style={styles.card}>
        <ThemedText style={styles.label}>Reef Doser device URL</ThemedText>
        <ThemedTextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrlState}
          placeholder="http://192.168.0.33:8000"
          placeholderTextColor={Colors.slate}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Pressable style={styles.button} onPress={handleSave}>
          <ThemedText style={styles.buttonText}>Save Device URL</ThemedText>
        </Pressable>
        {message ? <ThemedText style={styles.message}>{message}</ThemedText> : null}
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText style={styles.label}>Connection</ThemedText>
        <ThemedText style={styles.metric}>
          Saved URL: {savedUrl ?? 'none'}
        </ThemedText>
        <Pressable style={styles.resetButton} onPress={handleReset}>
          <ThemedText style={styles.resetText}>Change Device URL</ThemedText>
        </Pressable>
      </ThemedView>

      <ThemedView style={styles.infoCard}>
        <ThemedText style={styles.label}>SHARLAY Dose v1.0</ThemedText>
        <ThemedText style={styles.metric}>
          Smart Dosing. Stable Results.
        </ThemedText>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.md,
    backgroundColor: Colors.obsidian,
  },
  header: {
    ...Typography.h1,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
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
  input: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.3)',
    backgroundColor: Colors.midnight,
    color: Colors.pearl,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.body.fontSize,
    marginBottom: Spacing.md,
  },
  button: {
    height: 56,
    borderRadius: Radius.sm,
    backgroundColor: Colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  message: {
    ...Typography.small,
    color: Colors.titanium,
    marginTop: Spacing.sm,
  },
  metric: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.md,
  },
  resetButton: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.aqua,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetText: {
    ...Typography.body,
    color: Colors.aqua,
  },
  infoCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: 'auto',
  },
});
