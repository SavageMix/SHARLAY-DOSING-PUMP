import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import { getDeviceBaseUrl, getStatus, postDose, type PumpState, type StatusResponse } from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const PUMP_ORDER: PumpState['pumpId'][] = ['alk', 'ca', 'no3', 'po4'];

export default function DashboardScreen() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [doseInputs, setDoseInputs] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) setBaseUrl(url);
      });
      return () => {
        mounted = false;
      };
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      async function load() {
        if (!baseUrl) return;
        try {
          setLoading(true);
          const data = await getStatus(baseUrl);
          if (mounted) setStatus(data);
        } catch (err) {
          if (mounted) setStatus(null);
        } finally {
          if (mounted) setLoading(false);
        }
      }

      load();
      const interval = setInterval(load, 5000);
      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }, [baseUrl])
  );

  const sortedPumps = PUMP_ORDER
    .map((id) => status?.pumps.find((p) => p.pumpId === id))
    .filter((p): p is PumpState => p !== undefined);

  const handleDose = async (pumpId: PumpState['pumpId']) => {
    if (!baseUrl) return;
    const volumeMl = parseFloat(doseInputs[pumpId] ?? '');
    if (!volumeMl || volumeMl <= 0) {
      setMessages((m) => ({ ...m, [pumpId]: 'Enter a positive volume' }));
      return;
    }
    setMessages((m) => ({ ...m, [pumpId]: 'Queuing...' }));
    try {
      const res = await postDose(baseUrl, { pumpId, volumeMl });
      setMessages((m) => ({ ...m, [pumpId]: `Job ${res.jobId.slice(0, 8)}` }));
      setDoseInputs((i) => ({ ...i, [pumpId]: '' }));
    } catch (err) {
      setMessages((m) => ({
        ...m,
        [pumpId]: err instanceof Error ? err.message : 'Failed',
      }));
    }
  };

  if (!baseUrl) {
    return (
      <ThemedView style={styles.centered}>
        <ThemedText>No device URL configured.</ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.header}>Dashboard</ThemedText>
      <ThemedView style={styles.statusCard}>
        <ThemedText style={styles.metric}>
          Queue depth: {status?.queueDepth ?? 0}
        </ThemedText>
        <ThemedText style={styles.metric}>
          System volume: {status?.systemVolumeLitres ?? '?'} L
        </ThemedText>
        {loading && <ActivityIndicator color={Colors.aqua} />}
      </ThemedView>

      <FlatList
        data={sortedPumps}
        keyExtractor={(item) => item.pumpId}
        contentContainerStyle={styles.list}
        renderItem={({ item: pump }) => (
          <ThemedView style={styles.pumpCard}>
            <ThemedView style={styles.row}>
              <ThemedText style={styles.pumpTitle}>{pump.pumpId}</ThemedText>
              <ThemedText
                style={[
                  styles.badge,
                  pump.calibrated ? styles.success : styles.warning,
                ]}>
                {pump.calibrated ? 'Calibrated' : 'Uncalibrated'}
              </ThemedText>
            </ThemedView>

            <ThemedText style={styles.metric}>
              Steps/mL: {pump.stepsPerMl?.toFixed(1) ?? '—'}
            </ThemedText>
            <ThemedText style={styles.metric}>
              Container: {pump.containerRemainingMl.toFixed(1)} mL
            </ThemedText>
            <ThemedText style={styles.metric}>
              Today: {pump.todayDoseMl.toFixed(2)} mL
            </ThemedText>

            <View style={styles.doseRow}>
              <ThemedTextInput
                style={[styles.inputBase, styles.doseInput]}
                keyboardType="decimal-pad"
                placeholder="mL"
                placeholderTextColor={Colors.slate}
                value={doseInputs[pump.pumpId] ?? ''}
                onChangeText={(text) =>
                  setDoseInputs((i) => ({ ...i, [pump.pumpId]: text }))
                }
              />
              <Pressable
                style={styles.doseButton}
                onPress={() => handleDose(pump.pumpId)}>
                <ThemedText style={styles.doseButtonText}>DOSE</ThemedText>
              </Pressable>
            </View>
            {messages[pump.pumpId] ? (
              <ThemedText
                style={[
                  styles.message,
                  messages[pump.pumpId]?.startsWith('Job')
                    ? styles.ok
                    : styles.error,
                ]}>
                {messages[pump.pumpId]}
              </ThemedText>
            ) : null}
          </ThemedView>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.md,
    backgroundColor: Colors.obsidian,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    ...Typography.h1,
    color: Colors.pearl,
    marginBottom: Spacing.md,
  },
  statusCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  metric: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.xs,
  },
  list: {
    paddingBottom: Spacing.xl,
  },
  pumpCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  pumpTitle: {
    ...Typography.h2,
    color: Colors.pearl,
    textTransform: 'uppercase',
  },
  badge: {
    ...Typography.caption,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  success: {
    backgroundColor: Colors.success,
    color: Colors.obsidian,
  },
  warning: {
    backgroundColor: Colors.warning,
    color: Colors.obsidian,
  },
  doseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  inputBase: {
    height: 48,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.3)',
    backgroundColor: Colors.midnight,
    color: Colors.pearl,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.body.fontSize,
  },
  doseInput: {
    flex: 1,
  },
  doseButton: {
    height: 48,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.sm,
    backgroundColor: Colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doseButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  message: {
    ...Typography.small,
    marginTop: Spacing.sm,
  },
  ok: {
    color: Colors.success,
  },
  error: {
    color: Colors.danger,
  },
});
