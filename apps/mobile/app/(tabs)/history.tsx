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
  type HistoryDayGroup,
} from '@/src/lib/history-chart';
import {
  buildMonthHierarchy,
  flattenHierarchy,
  type HistoryMonthGroup,
  type HistoryRow,
  type HistoryWeekGroup,
} from '@/src/lib/history-groups';
import type { DoseEvent, PumpId } from '@reef/shared';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const DAYS_OPTIONS = [1, 7, 30, 90];

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
   * Drill-down: localDateKey of the day tapped on a 7d/30d/90d bar, with the
   * chart AND the list switched to that single day (hourly). Fifth state
   * alongside the 1d/7d/30d/90d pills — pills clear it, the pump filter
   * carries through it unchanged.
   */
  const [drillDate, setDrillDate] = useState<string | null>(null);
  /**
   * Expand/collapse overrides for list sections, keyed 'kind:key'
   * (month:/week:/day:). A section defaults to expanded only when it holds
   * the newest entries of its level; overrides persist for the session.
   */
  const [sectionOverrides, setSectionOverrides] = useState<
    Record<string, boolean>
  >({});

  const load = useCallback(
    async (showRefresh = false) => {
      if (!baseUrl) return;
      try {
        if (showRefresh) setRefreshing(true);
        else setLoading(true);
        setOffline(false);

        // Fetch the full 90-day window once; both the chart and the list
        // derive from it client-side — the range/pump controls filter the
        // same data, there is no separate hardcoded fetch.
        const data = await getHistory(baseUrl, {
          days: 90,
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

  // 90d hierarchy: month → week (Mon–Sun) → day, built FROM the day groups
  // so every level's sums agree with the chart buckets by construction.
  const hierarchy = useMemo(
    () => buildMonthHierarchy(filteredEvents),
    [filteredEvents],
  );

  type SectionKind = 'month' | 'week' | 'day';
  const sectionDefaults: Record<SectionKind, string | undefined> = {
    month: hierarchy[0]?.key,
    week: hierarchy[0]?.weeks[0]?.key,
    day: dayGroups[0]?.key,
  };
  const isSectionExpanded = (kind: SectionKind, key: string): boolean =>
    sectionOverrides[`${kind}:${key}`] ?? key === sectionDefaults[kind];
  const toggleSection = (kind: SectionKind, key: string) => {
    setSectionOverrides((prev) => ({
      ...prev,
      [`${kind}:${key}`]: !isSectionExpanded(kind, key),
    }));
  };

  // One row model for every mode — FlatList virtualizes rows, and collapsed
  // sections cost a single header row (only expanded sections render their
  // children).
  const rows = useMemo<HistoryRow[]>(() => {
    // 1d and drill-down are single-day views: flat list, no section headers.
    if (drillDate || filter.days === 1) {
      return filteredEvents.map((e) => ({
        kind: 'event',
        key: `event:${e.id}`,
        event: e,
      }));
    }
    if (filter.days === 90) {
      return flattenHierarchy(hierarchy, isSectionExpanded);
    }
    const out: HistoryRow[] = [];
    for (const g of dayGroups) {
      out.push({ kind: 'day', key: `day:${g.key}`, group: g });
      if (!isSectionExpanded('day', g.key)) continue;
      for (const e of g.events) {
        out.push({ kind: 'event', key: `event:${e.id}`, event: e });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filteredEvents,
    dayGroups,
    hierarchy,
    filter.days,
    drillDate,
    sectionOverrides,
  ]);

  const renderEventCard = (item: DoseEvent, nested = false) => (
    <ThemedView
      key={item.id}
      style={[styles.eventCard, nested && styles.eventCardNested]}>
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
        data={rows}
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
                : ` in last ${filter.days}d`}
            </ThemedText>
          </>
        }
        renderItem={({ item }) => {
          if (item.kind === 'event') {
            // Nested under a day section whenever a day header exists
            // (90d hierarchy); flush in flat 1d/drill mode.
            return renderEventCard(item.event, filter.days !== 1 && !drillDate);
          }
          const group = item.group;
          const expanded = isSectionExpanded(item.kind, group.key);
          const kindLabel =
            item.kind === 'month'
              ? 'month'
              : item.kind === 'week'
                ? 'week'
                : 'day';
          const indent =
            item.kind === 'month'
              ? null
              : item.kind === 'week'
                ? styles.weekHeader
                : styles.nestedDayHeader;
          return (
            <Pressable
              style={[styles.dayHeader, indent]}
              onPress={() => toggleSection(item.kind, group.key)}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`${group.label}, ${group.eventCount} events`}>
              <ThemedView style={styles.dayHeaderTextRow}>
                <ThemedText
                  style={[
                    styles.dayHeaderTitle,
                    item.kind === 'month' && styles.monthHeaderTitle,
                  ]}>
                  {group.label}
                </ThemedText>
                <ThemedText style={styles.dayHeaderSummary}>
                  {group.eventCount} event{group.eventCount === 1 ? '' : 's'}{' '}
                  · {group.deliveredMl.toFixed(1)} mL delivered
                </ThemedText>
              </ThemedView>
              <ThemedView style={styles.dayHeaderBadges}>
                {group.failedCount > 0 ? (
                  <ThemedText style={styles.failedBadge}>
                    {group.failedCount} failed
                  </ThemedText>
                ) : null}
                <Ionicons
                  name={expanded ? 'chevron-down' : 'chevron-forward'}
                  size={18}
                  color={Colors.titanium}
                />
              </ThemedView>
            </Pressable>
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
  // 90d hierarchy indent levels: month flush, week indented, day deeper.
  weekHeader: {
    marginLeft: Spacing.sm,
  },
  nestedDayHeader: {
    marginLeft: Spacing.md,
  },
  monthHeaderTitle: {
    ...Typography.h3,
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
  eventCardNested: {
    marginLeft: Spacing.lg,
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
