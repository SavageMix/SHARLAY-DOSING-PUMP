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
import { Ionicons } from '@expo/vector-icons';

import { HistoryChart } from '@/components/HistoryChart';
import { OfflineCard } from '@/components/OfflineCard';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/Themed';
import {
  getDeviceBaseUrl,
  getHistory,
  resolveDeviceBaseUrl,
} from '@/src/api/client';
import {
  formatDayHeaderLabel,
  groupEventsByDay,
  historyRangeStart,
  localDateKey,
} from '@/src/lib/history-chart';
import type { DoseEvent, PumpId } from '@reef/shared';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const DAYS_OPTIONS = [1, 7, 30];

/**
 * "Last N days" = since the start of the device-local calendar day
 * (today-(N-1)). Shared with the chart (historyRangeStart) so the graph
 * totals and this list always agree — one range definition for the screen.
 */
function isWithinDays(iso: string, days: number): boolean {
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t >= historyRangeStart(days, new Date());
}

export default function HistoryScreen() {
  const [events, setEvents] = useState<DoseEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<{ pumpId?: PumpId; days: number }>({
    days: 7,
  });
  /**
   * Drill-down: localDateKey of the day tapped on a 7d/30d bar, with the
   * chart AND the list switched to that single day (hourly). Fourth state
   * alongside the 1d/7d/30d pills — pills clear it, the pump filter carries
   * through it unchanged.
   */
  const [drillDate, setDrillDate] = useState<string | null>(null);
  /** Expand/collapse overrides; a day defaults to expanded only if newest. */
  const [expandedOverrides, setExpandedOverrides] = useState<
    Record<string, boolean>
  >({});

  const load = useCallback(
    async (showRefresh = false) => {
      if (!baseUrl) return;
      try {
        if (showRefresh) setRefreshing(true);
        else setLoading(true);
        setOffline(false);

        // Fetch the full 30-day window once; both the chart and the list
        // derive from it client-side — the range/pump controls filter the
        // same data, there is no separate hardcoded fetch.
        const data = await getHistory(baseUrl, {
          days: 30,
          limit: 10000,
          offset: 0,
        });

        setEvents(data?.events ?? []);
        setTotal(data?.total ?? 0);
      } catch {
        setOffline(true);
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
        if (mounted) setBaseUrl(resolveDeviceBaseUrl(url));
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
      // Drill-down wins over the pill range: the tapped day only. Same
      // localDateKey definition the chart buckets by.
      if (drillDate) {
        return localDateKey(new Date(e.startedAt)) === drillDate;
      }
      return isWithinDays(e.startedAt, filter.days);
    });
  }, [events, filter, drillDate]);

  // Day-grouped sections — same local-midnight split as the chart, so a
  // header's "mL delivered" always equals that day's bar total.
  const dayGroups = useMemo(() => groupEventsByDay(filteredEvents), [filteredEvents]);
  const newestDayKey = dayGroups[0]?.key;

  const toggleDay = (key: string) => {
    setExpandedOverrides((prev) => ({ ...prev, [key]: !isDayExpanded(key) }));
  };

  function isDayExpanded(key: string): boolean {
    return expandedOverrides[key] ?? key === newestDayKey;
  }

  const renderEventCard = (item: DoseEvent) => (
    <ThemedView key={item.id} style={styles.eventCard}>
      <ThemedView style={styles.row}>
        <ThemedText style={styles.pumpTitle}>{item.pumpId}</ThemedText>
        <ThemedView style={styles.badgeRow}>
          {item.source === 'catchup' ? (
            <ThemedText style={[styles.badge, styles.catchupBadge]}>
              Catch-up
            </ThemedText>
          ) : (
            <ThemedText
              style={[
                styles.badge,
                styles.sourceBadge,
                { backgroundColor: Colors.midnight },
              ]}>
              {item.source}
            </ThemedText>
          )}
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
      {item.source === 'catchup' && item.missedDoseScheduledFor ? (
        <ThemedText style={styles.catchupNote}>
          Missed {new Date(item.missedDoseScheduledFor).toLocaleString()}
        </ThemedText>
      ) : null}
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
      {offline && <OfflineCard onRetry={() => load(true)} />}
      <ThemedText style={styles.header}>History</ThemedText>

      <FlatList
        data={dayGroups}
        keyExtractor={(item) => item.key}
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
            <HistoryChart
              events={events}
              days={filter.days}
              pumpId={filter.pumpId}
              date={drillDate}
              onSelectDay={(key) =>
                // Toggle: tapping the already-selected day drills back out.
                setDrillDate((prev) => (prev === key ? null : key))
              }
              onBack={() => setDrillDate(null)}
            />

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
                    onPress={() => {
                      // Pills still pick the range; they exit any drill-down.
                      setDrillDate(null);
                      setFilter((f) => ({ ...f, days }));
                    }}>
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
              {drillDate
                ? ` on ${formatDayHeaderLabel(drillDate)}`
                : filter.days !== 30
                  ? ` in last ${filter.days}d`
                  : ''}
            </ThemedText>
          </>
        }
        renderItem={({ item }) => {
          const expanded = isDayExpanded(item.key);
          return (
            <ThemedView style={styles.daySection}>
              <Pressable
                style={styles.dayHeader}
                onPress={() => toggleDay(item.key)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${item.label}, ${item.eventCount} events`}>
                <ThemedView style={styles.dayHeaderTextRow}>
                  <ThemedText style={styles.dayHeaderTitle}>
                    {item.label}
                  </ThemedText>
                  <ThemedText style={styles.dayHeaderSummary}>
                    {item.eventCount} event{item.eventCount === 1 ? '' : 's'} ·{' '}
                    {item.deliveredMl.toFixed(1)} mL delivered
                  </ThemedText>
                </ThemedView>
                <ThemedView style={styles.dayHeaderBadges}>
                  {item.failedCount > 0 ? (
                    <ThemedText style={styles.failedBadge}>
                      {item.failedCount} failed
                    </ThemedText>
                  ) : null}
                  <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={18}
                    color={Colors.titanium}
                  />
                </ThemedView>
              </Pressable>
              {expanded
                ? item.events.map((event) => renderEventCard(event))
                : null}
            </ThemedView>
          );
        }}
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
  daySection: {
    marginBottom: Spacing.sm,
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  dayHeaderTextRow: {
    flexShrink: 1,
  },
  dayHeaderTitle: {
    ...Typography.h3,
    color: Colors.pearl,
  },
  dayHeaderSummary: {
    ...Typography.small,
    color: Colors.titanium,
    marginTop: 2,
  },
  dayHeaderBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  failedBadge: {
    ...Typography.caption,
    color: Colors.pearl,
    backgroundColor: Colors.danger,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  eventCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    marginLeft: Spacing.sm,
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
  catchupBadge: {
    backgroundColor: Colors.warning,
    color: Colors.obsidian,
  },
  catchupNote: {
    ...Typography.small,
    color: Colors.warning,
    marginBottom: Spacing.xs,
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
