import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import { getDeviceBaseUrl, getSchedules, createSchedule, deleteSchedule, type DoseSchedule } from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const PUMP_ORDER: DoseSchedule['pumpId'][] = ['alk', 'ca', 'no3', 'po4'];

export default function SchedulesScreen() {
  const [schedules, setSchedules] = useState<DoseSchedule[]>([]);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    pumpId: 'alk' as DoseSchedule['pumpId'],
    volumeMl: '',
    cron: '0 9 * * *',
    enabled: true,
  });
  const [message, setMessage] = useState('');

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) setBaseUrl(url);
      });
      return () => { mounted = false; };
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      async function load() {
        if (!baseUrl) return;
        try {
          setLoading(true);
          const data = await getSchedules(baseUrl);
          if (mounted) setSchedules(data.schedules);
        } finally {
          if (mounted) setLoading(false);
        }
      }
      load();
      return () => { mounted = false; };
    }, [baseUrl])
  );

  const handleCreate = async () => {
    if (!baseUrl) return;
    const volumeMl = parseFloat(form.volumeMl);
    if (!volumeMl || volumeMl <= 0) {
      setMessage('Enter a positive volume');
      return;
    }
    try {
      await createSchedule(baseUrl, {
        pumpId: form.pumpId,
        volumeMl,
        cron: form.cron,
        enabled: form.enabled,
      });
      setMessage('Schedule created');
      setForm({ pumpId: 'alk', volumeMl: '', cron: '0 9 * * *', enabled: true });
      const data = await getSchedules(baseUrl);
      setSchedules(data.schedules);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleDelete = async (id: string) => {
    if (!baseUrl) return;
    try {
      await deleteSchedule(baseUrl, id);
      const data = await getSchedules(baseUrl);
      setSchedules(data.schedules);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
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
      <ThemedText style={styles.header}>Schedules</ThemedText>

      <ThemedView style={styles.formCard}>
        <ThemedView style={styles.pickerRow}>
          {PUMP_ORDER.map((id) => (
            <Pressable
              key={id}
              style={[
                styles.pumpChip,
                form.pumpId === id && styles.pumpChipActive,
              ]}
              onPress={() => setForm((f) => ({ ...f, pumpId: id }))}>
              <ThemedText
                style={[
                  styles.chipText,
                  form.pumpId === id && styles.chipTextActive,
                ]}>
                {id}
              </ThemedText>
            </Pressable>
          ))}
        </ThemedView>

        <ThemedTextInput
          style={styles.input}
          placeholder="Volume (mL)"
          placeholderTextColor={Colors.slate}
          keyboardType="decimal-pad"
          value={form.volumeMl}
          onChangeText={(text) => setForm((f) => ({ ...f, volumeMl: text }))}
        />
        <ThemedTextInput
          style={styles.input}
          placeholder="Cron expression"
          placeholderTextColor={Colors.slate}
          value={form.cron}
          onChangeText={(text) => setForm((f) => ({ ...f, cron: text }))}
        />

        <Pressable style={styles.button} onPress={handleCreate}>
          <ThemedText style={styles.buttonText}>Add Schedule</ThemedText>
        </Pressable>
        {message ? <ThemedText style={styles.message}>{message}</ThemedText> : null}
      </ThemedView>

      {loading && <ActivityIndicator color={Colors.aqua} style={styles.loader} />}

      <FlatList
        data={schedules}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <ThemedView style={styles.scheduleCard}>
            <ThemedView style={styles.row}>
              <ThemedText style={styles.pumpTitle}>{item.pumpId}</ThemedText>
              <ThemedText
                style={[
                  styles.badge,
                  item.enabled ? styles.success : styles.warning,
                ]}>
                {item.enabled ? 'enabled' : 'disabled'}
              </ThemedText>
            </ThemedView>
            <ThemedText style={styles.metric}>
              {item.volumeMl} mL — {item.cron}
            </ThemedText>
            {item.lastRunAt ? (
              <ThemedText style={styles.metric}>
                Last run: {new Date(item.lastRunAt).toLocaleString()}
              </ThemedText>
            ) : null}
            <Pressable
              style={styles.deleteButton}
              onPress={() => handleDelete(item.id)}>
              <ThemedText style={styles.deleteText}>Delete</ThemedText>
            </Pressable>
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
  formCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  pickerRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  pumpChip: {
    flex: 1,
    height: 44,
    borderRadius: Radius.sm,
    backgroundColor: Colors.midnight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pumpChipActive: {
    borderColor: Colors.aqua,
    backgroundColor: Colors.midnight,
  },
  chipText: {
    ...Typography.body,
    color: Colors.titanium,
    textTransform: 'uppercase',
  },
  chipTextActive: {
    color: Colors.aqua,
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
  loader: {
    marginVertical: Spacing.md,
  },
  list: {
    paddingBottom: Spacing.xl,
  },
  scheduleCard: {
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
    ...Typography.h3,
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
  metric: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.xs,
  },
  deleteButton: {
    marginTop: Spacing.sm,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  deleteText: {
    ...Typography.body,
    color: Colors.danger,
  },
});
