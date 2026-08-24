import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { G, Rect, Text as SvgText } from 'react-native-svg';

import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/Themed';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import type { DoseEvent, PumpId } from '@reef/shared';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

const PUMP_COLORS: Record<PumpId, string> = {
  alk: Colors.aqua,
  ca: Colors.coral,
  no3: Colors.violet,
  po4: Colors.blue,
};

const CHART_HEIGHT = 220;
const MARGIN = { top: 8, right: 8, bottom: 32, left: 40 };

interface HistoryChartProps {
  events: DoseEvent[];
  days: number;
}

function toLocalDateString(iso: string): string {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 10);
}

function buildDayLabels(days: number): string[] {
  const labels: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }
  return labels;
}

function formatDay(label: string): string {
  const d = new Date(label + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

export function HistoryChart({ events, days }: HistoryChartProps) {
  const [visible, setVisible] = useState<Record<PumpId, boolean>>({
    alk: true,
    ca: true,
    no3: true,
    po4: true,
  });
  const [width, setWidth] = useState(0);

  const { labels, data, maxTotal } = useMemo(() => {
    const labels = buildDayLabels(days);
    const totals = new Map<string, Record<PumpId, number>>();

    for (const label of labels) {
      totals.set(label, { alk: 0, ca: 0, no3: 0, po4: 0 });
    }

    for (const event of events) {
      if (event.status !== 'completed' || event.actualMl === null) continue;
      const day = toLocalDateString(event.startedAt);
      const dayTotals = totals.get(day);
      if (dayTotals) {
        dayTotals[event.pumpId] += event.actualMl;
      }
    }

    const data = labels.map((label) => ({
      label,
      values: { ...totals.get(label)! },
      total: PUMP_ORDER.reduce((sum, pumpId) => {
        return visible[pumpId] ? sum + totals.get(label)![pumpId] : sum;
      }, 0),
    }));

    const maxTotal = Math.max(...data.map((d) => d.total), 1);
    return { labels, data, maxTotal };
  }, [events, days, visible]);

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const barSlot = labels.length > 0 ? plotWidth / labels.length : 0;
  const barWidth = Math.max(4, barSlot * 0.65);
  const yScale = plotHeight / maxTotal;

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
      <ThemedText style={styles.title}>Last {days} days</ThemedText>

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
                    {Math.round(tick)}
                  </SvgText>
                </G>
              );
            })}

            {/* Bars */}
            {data.map((day, index) => {
              const x = MARGIN.left + index * barSlot + (barSlot - barWidth) / 2;
              let y = MARGIN.top + plotHeight;

              return (
                <G key={day.label}>
                  {PUMP_ORDER.map((pumpId) => {
                    if (!visible[pumpId]) return null;
                    const amount = day.values[pumpId];
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
                  <SvgText
                    x={x + barWidth / 2}
                    y={CHART_HEIGHT - 8}
                    fill={Colors.titanium}
                    fontSize={9}
                    textAnchor="middle"
                    transform={`rotate(-35, ${x + barWidth / 2}, ${CHART_HEIGHT - 8})`}>
                    {formatDay(day.label)}
                  </SvgText>
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
