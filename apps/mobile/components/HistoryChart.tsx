import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Rect, Text as SvgText } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/Themed';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import {
  bucketTotal,
  buildHistoryBuckets,
  historyChartDrillTitle,
  historyChartTitle,
} from '@/src/lib/history-chart';
import type { DoseEvent, PumpId } from '@reef/shared';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

const PUMP_COLORS: Record<PumpId, string> = {
  alk: Colors.aqua,
  ca: Colors.coral,
  no3: Colors.violet,
  po4: Colors.blue,
};

const CHART_HEIGHT = 220;
const MARGIN = { top: 14, right: 8, bottom: 32, left: 40 };

interface HistoryChartProps {
  events: DoseEvent[];
  days: number;
  /** Pump filter from the screen — set: single-pump series, legend hidden. */
  pumpId?: PumpId;
  /**
   * Drill-down state: a localDateKey the user tapped in a 7d/30d bar. When
   * set, the chart shows that day's hourly buckets; `days` is kept so the
   * back affordance can name the range it returns to.
   */
  date?: string | null;
  /** Range-mode bar tap (drill in; the parent toggles — tapping the
      already-selected day drills back out). */
  onSelectDay?: (dateKey: string) => void;
  /** Back affordance — only rendered while `date` is set. */
  onBack?: () => void;
}

export function HistoryChart({
  events,
  days,
  pumpId,
  date,
  onSelectDay,
  onBack,
}: HistoryChartProps) {
  const [visible, setVisible] = useState<Record<PumpId, boolean>>({
    alk: true,
    ca: true,
    no3: true,
    po4: true,
  });
  const [width, setWidth] = useState(0);

  const { buckets, maxTotal } = useMemo(() => {
    // Same data as the events list — the pump filter only narrows which
    // events feed the series, there is no separate fetch.
    const relevant = pumpId
      ? events.filter((e) => e.pumpId === pumpId)
      : events;
    const buckets = buildHistoryBuckets(relevant, days, new Date(), date);
    const maxTotal = Math.max(
      ...buckets.map((b) => bucketTotal(b, visible)),
      1,
    );
    return { buckets, maxTotal };
  }, [events, days, pumpId, date, visible]);

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = buckets.length > 0 ? plotWidth / buckets.length : 0;
  const barWidth = Math.max(4, slot * 0.65);
  const yScale = plotHeight / maxTotal;
  const hourly = date != null || days === 1;
  // 24 hourly labels don't fit rotated — show every 3rd hour (00, 03, …).
  const labelEvery = hourly ? 3 : 1;
  // Only daily bars are tappable — 1d is already hourly, and while drilled
  // in there is a single day on screen (the back affordance exits).
  const tapTarget = date == null && days !== 1 ? onSelectDay : undefined;

  const yTicks = useMemo(() => {
    const tickCount = 4;
    const step = maxTotal / tickCount;
    return Array.from({ length: tickCount + 1 }, (_, i) => i * step);
  }, [maxTotal]);

  function togglePump(pumpId: PumpId) {
    setVisible((v) => ({ ...v, [pumpId]: !v[pumpId] }));
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.title}>
        {date ? historyChartDrillTitle(date) : historyChartTitle(days)}
      </ThemedText>

      {date ? (
        <Pressable
          style={styles.backRow}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={`Back to last ${days} days`}>
          <Ionicons name="arrow-back" size={16} color={Colors.aqua} />
          <ThemedText style={styles.backText}>
            Back to Last {days} days
          </ThemedText>
        </Pressable>
      ) : null}

      {!pumpId ? (
        <View style={styles.legend}>
          {PUMP_ORDER.map((pumpId) => (
            <Pressable
              key={pumpId}
              style={[styles.legendChip, !visible[pumpId] && styles.legendChipDimmed]}
              onPress={() => togglePump(pumpId)}>
              <View style={[styles.dot, { backgroundColor: PUMP_COLORS[pumpId] }]} />
              <ThemedText style={styles.legendText}>{pumpId}</ThemedText>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View
        style={styles.chartArea}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <Svg width={width} height={CHART_HEIGHT}>
            {/* Y-axis grid lines */}
            {yTicks.map((tick, i) => {
              const y = MARGIN.top + plotHeight - tick * yScale;
              return (
                <G key={`grid-${i}`}>
                  <Rect
                    x={MARGIN.left}
                    y={y - 0.5}
                    width={plotWidth}
                    height={1}
                    fill={Colors.midnight}
                  />
                  <SvgText
                    x={MARGIN.left - 6}
                    y={y + 4}
                    fill={Colors.titanium}
                    fontSize={10}
                    textAnchor="end">
                    {tick.toFixed(1)}
                  </SvgText>
                </G>
              );
            })}

            {/* Bars — stacked per pump; empty buckets render as zero height,
                never as a gap in the axis. In 7d/30d each bar is a tap
                target for drilling into that day. */}
            {buckets.map((bucket, index) => {
              const x = MARGIN.left + index * slot + (slot - barWidth) / 2;
              let y = MARGIN.top + plotHeight;
              const isDrilled = date === bucket.key;

              return (
                <G
                  key={bucket.key}
                  onPress={
                    tapTarget ? () => tapTarget(bucket.key) : undefined
                  }>
                  {isDrilled ? (
                    <Rect
                      x={x - 2}
                      y={MARGIN.top}
                      width={barWidth + 4}
                      height={plotHeight}
                      fill="rgba(32, 227, 216, 0.12)"
                      rx={3}
                    />
                  ) : null}
                  {PUMP_ORDER.map((pumpId) => {
                    if (!visible[pumpId]) return null;
                    const amount = bucket.values[pumpId];
                    const h = amount * yScale;
                    const segmentY = y - h;
                    y = segmentY;

                    return h > 0 ? (
                      <Rect
                        key={pumpId}
                        x={x}
                        y={segmentY}
                        width={barWidth}
                        height={h}
                        fill={PUMP_COLORS[pumpId]}
                        rx={2}
                      />
                    ) : null;
                  })}
                  {/* Failed/interrupted marker: the bucket is visible even
                      when its delivered total is zero — a bad day must not
                      read as a quiet no-dose day. */}
                  {bucket.failed ? (
                    <Circle
                      cx={x + barWidth / 2}
                      cy={Math.max(y - 6, MARGIN.top + 3)}
                      r={3}
                      fill={Colors.danger}
                    />
                  ) : null}
                  {index % labelEvery === 0 ? (
                    <SvgText
                      x={x + barWidth / 2}
                      y={CHART_HEIGHT - 8}
                      fill={Colors.titanium}
                      fontSize={9}
                      textAnchor="middle"
                      transform={`rotate(-35, ${x + barWidth / 2}, ${CHART_HEIGHT - 8})`}>
                      {bucket.label}
                    </SvgText>
                  ) : null}
                </G>
              );
            })}
          </Svg>
        )}
      </View>

      {maxTotal <= 1 && events.length > 0 && (
        <ThemedText style={styles.empty}>No completed doses in this range.</ThemedText>
      )}
      {events.length === 0 && (
        <ThemedText style={styles.empty}>No dose history yet.</ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    backgroundColor: Colors.abyss,
  },
  title: {
    ...Typography.h3,
    color: Colors.pearl,
    marginBottom: Spacing.sm,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  backText: {
    ...Typography.body,
    color: Colors.aqua,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  legendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
    backgroundColor: Colors.midnight,
  },
  legendChipDimmed: {
    opacity: 0.4,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    ...Typography.caption,
    color: Colors.pearl,
    textTransform: 'uppercase',
  },
  chartArea: {
    height: CHART_HEIGHT,
  },
  empty: {
    ...Typography.small,
    color: Colors.titanium,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
});
