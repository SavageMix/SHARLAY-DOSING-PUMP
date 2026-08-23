import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { getDeviceBaseUrl, setDeviceBaseUrl } from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const DEFAULT_URL = 'http://192.168.0.33:8000';

export default function SetupScreen() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getDeviceBaseUrl().then((stored) => {
      if (stored) {
        router.replace('/(tabs)');
      } else {
        setUrl(DEFAULT_URL);
        setLoading(false);
      }
    });
  }, [router]);

  const handleSave = async () => {
    if (!url.trim()) {
      setError('Please enter the device URL');
      return;
    }
    try {
      await setDeviceBaseUrl(url.trim());
      router.replace('/(tabs)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save URL');
    }
  };

  if (loading) {
    return (
      <ThemedView style={styles.container}>
        <ActivityIndicator size="large" color={Colors.aqua} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.title}>SHARLAY</ThemedText>
      <ThemedText style={styles.subtitle}>Smart Dosing. Stable Results.</ThemedText>

      <View style={styles.card}>
        <ThemedText style={styles.label}>Reef Doser device URL</ThemedText>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="http://192.168.0.33:8000"
          placeholderTextColor={Colors.slate}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}
        <Pressable style={styles.button} onPress={handleSave}>
          <ThemedText style={styles.buttonText}>Connect</ThemedText>
        </Pressable>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  title: {
    ...Typography.display,
    color: Colors.aqua,
    letterSpacing: 8,
    marginBottom: Spacing.sm,
  },
  subtitle: {
    ...Typography.small,
    color: Colors.titanium,
    marginBottom: Spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.lg,
  },
  label: {
    ...Typography.body,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
  input: {
    height: 56,
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
    marginTop: Spacing.sm,
  },
  buttonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  error: {
    color: Colors.danger,
    fontSize: Typography.small.fontSize,
    marginBottom: Spacing.md,
  },
});
