import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/Themed';
import { getDeviceBaseUrl, getHistory, type DoseEvent } from '@/src/api/client';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const PUMP_ORDER: DoseEvent['pumpId'][] = ['alk', 'ca', 'no3', 'po4'];
const DAYS = [1, 7, 30];

export default function HistoryScreen() {
  const [events, setEvents] = useState<DoseEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<{ pumpId?: DoseEvent['pumpId']; days: number }>({
    days: 7,
  });

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
          const data = await getHistory(baseUrl, {
            pumpId: filter.pumpId,
            days: filter.days,
            limit: 100,
            offset: 0,
          });
          if (mounted) {
            setEvents(data.events);
            setTotal(data.total);
          }
        } finally {
          if (mounted) setLoading(false);
        }
      }
      load();
      return () => { mounted = false; };
    }, [baseUrl, filter])
  );

  if (!baseUrl) {
    return (
      <ThemedView style={styles.centered}>
        <ThemedText>No device URL configured.</ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.header}>History</ThemedText>

      <ThemedView style={styles.filterCard}>
        <ThemedText style={styles.label}>Pump</ThemedText>
        <View style={styles.chipRow}>
          <Pressable
            style={[styles.chip, !filter.pumpId && styles.chipActive]}
            onPress={() => setFilter((f) => ({ ...f, pumpId: undefined }))}>
            <ThemedText style={[!filter.pumpId ? styles.chipTextActive : styles.chipText]}>
              All
            </ThemedText>
          </Pressable>
          {PUMP_ORDER.map((id) => (
            <Pressable
              key={id}
              style={[styles.chip, filter.pumpId === id && styles.chipActive]}
              onPress={() => setFilter((f) => ({ ...f, pumpId: id }))}>
              <ThemedText style={[filter.pumpId === id ? styles.chipTextActive : styles.chipText]}>
                {id}
              </ThemedText>
            </Pressable>
          ))}
        </View>

        <ThemedText style={styles.label}>Days</ThemedText>
        <View style={styles.chipRow}>
          {DAYS.map((days) => (
            <Pressable
              key={days}
              style={[styles.chip, filter.days === days && styles.chipActive]}
              onPress={() => setFilter((f) => ({ ...f, days }))}>
              <ThemedText style={[filter.days === days ? styles.chipTextActive : styles.chipText]}>
                {days}d
              </ThemedText>
            </Pressable>
          ))}
        </View>
      </ThemedView>

      {loading && <ActivityIndicator color={Colors.aqua} style={styles.loader} />}

      <ThemedText style={styles.count}>
        {total} event{total !== 1 ? 's' : ''}
      </ThemedText>

      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <ThemedView style={styles.eventCard}>
            <ThemedView style={styles.row}>
              <ThemedText style={styles.pumpTitle}>{item.pumpId}</ThemedText>
              <ThemedText
                style={[
                  styles.badge,
                  item.status === 'completed'
                    ? styles.success
                    : item.status === 'running'
                    ? styles.info
                    : styles.error,
                ]}>
                {item.status}
              </ThemedText>
            </ThemedView>
            <ThemedText style={styles.metric}>
              Requested: {item.requestedMl} mL
            </ThemedText>
            {item.actualMl !== null ? (
              <ThemedText style={styles.metric}>
                Actual: {item.actualMl} mL
              </ThemedText>
            ) : null}
            <ThemedText style={styles.metric}>
              {new Date(item.startedAt).toLocaleString()}
            </ThemedText>
            {item.error ? (
              <ThemedText style={styles.errorText}>{item.error}</ThemedText>
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
  filterCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  label: {
    ...Typography.small,
    color: Colors.titanium,
    marginBottom: Spacing.sm,
    marginTop: Spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
    backgroundColor: Colors.midnight,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipActive: {
    borderColor: Colors.aqua,
  },
  chipText: {
    ...Typography.body,
    color: Colors.titanium,
  },
  chipTextActive: {
    color: Colors.aqua,
  },
  loader: {
    marginVertical: Spacing.md,
  },
  count: {
    ...Typography.small,
    color: Colors.titanium,
    marginBottom: Spacing.sm,
  },
  list: {
    paddingBottom: Spacing.xl,
  },
  eventCard: {
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
  info: {
    backgroundColor: Colors.blue,
    color: Colors.pearl,
  },
  error: {
    backgroundColor: Colors.danger,
    color: Colors.pearl,
  },
  metric: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.xs,
  },
  errorText: {
    ...Typography.small,
    color: Colors.danger,
    marginTop: Spacing.sm,
  },
});
