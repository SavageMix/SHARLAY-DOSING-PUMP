import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import { HistoryChart } from '@/components/HistoryChart';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/Themed';
import { getDeviceBaseUrl, getHistory } from '@/src/api/client';
import type { DoseEvent, PumpId } from '@reef/shared';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const DAYS_OPTIONS = [1, 7, 30];

function toLocalDateString(iso: string): string {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

function isWithinDays(iso: string, days: number): boolean {
  const then = new Date(iso).getTime();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return then >= cutoff;
}

export default function HistoryScreen() {
  const [events, setEvents] = useState<DoseEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<{ pumpId?: PumpId; days: number }>({
    days: 7,
  });

  const load = useCallback(
    async (showRefresh = false) => {
      if (!baseUrl) return;
      try {
        if (showRefresh) setRefreshing(true);
        else setLoading(true);

        // Fetch the full 30-day window once; the chart always uses 30 days,
        // and the list is filtered client-side for responsiveness.
        const data = await getHistory(baseUrl, {
          days: 30,
          limit: 10000,
          offset: 0,
        });

        setEvents(data.events);
        setTotal(data.total);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [baseUrl],
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) setBaseUrl(url);
      });
      return () => {
        mounted = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (filter.pumpId && e.pumpId !== filter.pumpId) return false;
      return isWithinDays(e.startedAt, filter.days);
    });
  }, [events, filter]);

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

      <FlatList
        data={filteredEvents}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={Colors.aqua}
            colors={[Colors.aqua]}
          />
        }
        ListHeaderComponent={
          <>
            <HistoryChart events={events} days={30} />

            <ThemedView style={styles.filterCard}>
              <ThemedText style={styles.label}>Pump</ThemedText>
              <View style={styles.chipRow}>
                <Pressable
                  style={[styles.chip, !filter.pumpId && styles.chipActive]}
                  onPress={() =>
                    setFilter((f) => ({ ...f, pumpId: undefined }))
                  }>
                  <ThemedText
                    style={[
                      !filter.pumpId
                        ? styles.chipTextActive
                        : styles.chipText,
                    ]}>
                    All
                  </ThemedText>
                </Pressable>
                {PUMP_ORDER.map((id) => (
                  <Pressable
                    key={id}
                    style={[
                      styles.chip,
                      filter.pumpId === id && styles.chipActive,
                    ]}
                    onPress={() => setFilter((f) => ({ ...f, pumpId: id }))}>
                    <ThemedText
                      style={[
                        filter.pumpId === id
                          ? styles.chipTextActive
                          : styles.chipText,
                      ]}>
                      {id}
                    </ThemedText>
                  </Pressable>
                ))}
              </View>

              <ThemedText style={styles.label}>Days</ThemedText>
              <View style={styles.chipRow}>
                {DAYS_OPTIONS.map((days) => (
                  <Pressable
                    key={days}
                    style={[
                      styles.chip,
                      filter.days === days && styles.chipActive,
                    ]}
                    onPress={() => setFilter((f) => ({ ...f, days }))}>
                    <ThemedText
                      style={[
                        filter.days === days
                          ? styles.chipTextActive
                          : styles.chipText,
                      ]}>
                      {days}d
                    </ThemedText>
                  </Pressable>
                ))}
              </View>
            </ThemedView>

            {loading && !refreshing && (
              <ActivityIndicator color={Colors.aqua} style={styles.loader} />
            )}

            <ThemedText style={styles.count}>
              {filteredEvents.length} event
              {filteredEvents.length !== 1 ? 's' : ''}
              {filter.days !== 30 ? ` in last ${filter.days}d` : ''}
            </ThemedText>
          </>
        }
        renderItem={({ item }) => (
          <ThemedView style={styles.eventCard}>
            <ThemedView style={styles.row}>
              <ThemedText style={styles.pumpTitle}>{item.pumpId}</ThemedText>
              <ThemedView style={styles.badgeRow}>
                <ThemedText
                  style={[
                    styles.badge,
                    styles.sourceBadge,
                    { backgroundColor: Colors.midnight },
                  ]}>
                  {item.source}
                </ThemedText>
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
            </ThemedView>
            <ThemedText style={styles.metric}>
              Requested: {item.requestedMl.toFixed(2)} mL
            </ThemedText>
            {item.actualMl !== null ? (
              <ThemedText style={styles.metric}>
                Actual: {item.actualMl.toFixed(2)} mL
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
        ListEmptyComponent={
          !loading ? (
            <ThemedText style={styles.empty}>
              No dose events match the selected filters.
            </ThemedText>
          ) : null
        }
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
  badgeRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
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
  sourceBadge: {
    color: Colors.titanium,
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
  empty: {
    ...Typography.body,
    color: Colors.titanium,
    textAlign: 'center',
    marginTop: Spacing.lg,
  },
});
