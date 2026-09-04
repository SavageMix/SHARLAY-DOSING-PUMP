import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Polyline,
  Stop,
  Svg,
} from 'react-native-svg';

import { SharlayWordmark } from '@/components/SharlayWordmark';
import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  confirmMissedDose,
  dismissMissedDose,
  getDeviceBaseUrl,
  getHistory,
  getLimits,
  getMissedDoses,
  getSchedules,
  getStatus,
  postDose,
  resolveDeviceBaseUrl,
  type MissedDose,
  type StatusResponse,
} from '@/src/api/client';
import { Theme } from '@/constants/Theme';
import {
  getNextDueDate,
  type DoseEvent,
  type DoseSchedule,
  type HistoryResponse,
  type LimitsResponse,
  type PumpId,
  type PumpState,
} from '@reef/shared';

const T = Theme;
const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const SCREEN_WIDTH = Dimensions.get('window').width;

const PUMP_DISPLAY_NAMES: Record<PumpId, string> = {
  alk: 'Alkalinity',
  ca: 'Calcium',
  no3: 'Nitrate',
  po4: 'Phosphate',
};

const PUMP_COLORS: Record<PumpId, string> = {
  alk: T.colors.primary,
  ca: T.colors.accent,
  no3: T.colors.danger,
  po4: T.colors.success,
};

interface DashboardData {
  status: StatusResponse;
  schedules: DoseSchedule[];
  limits: LimitsResponse;
  missedDoses: MissedDose[];
  history: HistoryResponse;
}

interface DoseState {
  status: 'idle' | 'queued' | 'running' | 'done' | 'error';
  message: string;
  eventId?: string;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(date: Date): string {
  return `${date.toLocaleDateString()} ${formatTime(date)}`;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  return `In ${hh}:${mm}:${ss}`;
}

function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const rad = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function computeDosingConsistency(
  history: DoseEvent[],
  schedules: DoseSchedule[],
): { score: number | null; label: string } {
  const enabled = schedules.filter((s) => s.enabled);
  if (enabled.length === 0) return { score: null, label: 'No data yet' };

  const days = 30;
  const expected = enabled.reduce(
    (sum, s) => sum + (days / s.repeatEveryNDays) * s.timesPerDay,
    0,
  );
  if (expected <= 0) return { score: null, label: 'No data yet' };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const completed = history.events.filter(
    (e) =>
      e.source === 'schedule' &&
      e.status === 'completed' &&
      new Date(e.startedAt).getTime() >= cutoff,
  ).length;

  const score = Math.min(100, Math.round((completed / expected) * 100));
  let label = 'Poor';
  if (score >= 95) label = 'Excellent';
  else if (score >= 85) label = 'Good';
  else if (score >= 70) label = 'Fair';
  return { score, label };
}

function computePumpSparkline(
  history: DoseEvent[],
  pumpId: PumpId,
  daysBack: number,
): number[] {
  const today = startOfDay(new Date()).getTime();
  const values: number[] = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const dayStart = today - i * 24 * 60 * 60 * 1000;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const sum = history.events
      .filter(
        (e) =>
          e.pumpId === pumpId &&
          e.status === 'completed' &&
          new Date(e.startedAt).getTime() >= dayStart &&
          new Date(e.startedAt).getTime() < dayEnd,
      )
      .reduce((total, e) => total + (e.actualMl ?? e.requestedMl), 0);
    values.push(sum);
  }
  return values;
}

function computeTodayTotal(history: DoseEvent[], pumpId: PumpId): number {
  const today = startOfDay(new Date()).getTime();
  return history.events
    .filter(
      (e) =>
        e.pumpId === pumpId &&
        e.status === 'completed' &&
        new Date(e.startedAt).getTime() >= today,
    )
    .reduce((total, e) => total + (e.actualMl ?? e.requestedMl), 0);
}

function computeNextDose(
  schedules: DoseSchedule[],
): { schedule: DoseSchedule; date: Date } | null {
  const now = new Date();
  let best: { schedule: DoseSchedule; date: Date } | null = null;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const date = getNextDueDate(schedule, now);
    if (!date) continue;
    if (!best || date < best.date) {
      best = { schedule, date };
    }
  }
  return best;
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const width = 64;
  const height = 24;
  if (data.length < 2 || Math.max(...data) <= 0) {
    return (
      <Svg width={width} height={height}>
        <Polyline
          points={`0,${height / 2} ${width},${height / 2}`}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeOpacity="0.4"
          strokeLinecap="round"
          strokeDasharray="2,2"
        />
      </Svg>
    );
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Svg width={width} height={height}>
      <LinearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={color} stopOpacity="0.35" />
        <Stop offset="1" stopColor={color} stopOpacity="0" />
      </LinearGradient>
      <Path
        d={`M 0 ${height} L ${points.replace(/ /g, ' L ')} L ${width} ${height} Z`}
        fill="url(#sparkFill)"
      />
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function Header({ loading }: { loading: boolean }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTitleRow}>
        <SharlayWordmark width={160} />
        <View style={styles.headerIcons}>
          {loading && (
            <ActivityIndicator size="small" color={T.colors.primary} />
          )}
          <Ionicons
            name="notifications-outline"
            size={24}
            color={T.colors.textPrimary}
          />
        </View>
      </View>
      <View style={styles.greetingRow}>
        <ThemedText style={styles.greetingLabel}>{getGreeting()},</ThemedText>
        <ThemedText style={styles.greetingName}>Reef Keeper</ThemedText>
      </View>
    </View>
  );
}

function SystemStatusCard({ offline }: { offline: boolean }) {
  return (
    <View style={styles.glassCard}>
      <View style={styles.statusRow}>
        <View style={styles.statusLeft}>
          <View style={styles.statusLabelRow}>
            <View
              style={[
                styles.statusDot,
                offline
                  ? { backgroundColor: T.colors.danger }
                  : { backgroundColor: T.colors.success },
              ]}
            />
            <ThemedText style={styles.statusOverline}>SYSTEM STATUS</ThemedText>
          </View>
          <ThemedText style={styles.statusTitle}>
            {offline ? 'Device Offline' : 'All Systems Normal'}
          </ThemedText>
          <ThemedText style={styles.statusSub}>
            {offline
              ? 'Tap to retry connection.'
              : 'Everything is running smoothly.'}
          </ThemedText>
        </View>
        <View
          style={[
            styles.statusIconRing,
            offline
              ? { borderColor: T.colors.danger }
              : { borderColor: T.colors.success },
          ]}>
          <Ionicons
            name={offline ? 'alert' : 'checkmark'}
            size={28}
            color={offline ? T.colors.danger : T.colors.success}
          />
        </View>
      </View>
    </View>
  );
}

function gaugeLabelColor(rating: string): string {
  switch (rating) {
    case 'Poor':
      return T.colors.danger;
    case 'Fair':
      return T.colors.warning;
    case 'Good':
      return T.colors.primary;
    case 'Excellent':
    default:
      return T.colors.primary;
  }
}

function CardBackdrop({ width, height }: { width: number; height: number }) {
  return (
    <Svg
      width={width}
      height={height}
      viewBox="0 0 300 180"
      preserveAspectRatio="none"
      style={StyleSheet.absoluteFillObject}>
      <Defs>
        <LinearGradient id="bgGlow" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={T.colors.surface} stopOpacity="1" />
          <Stop offset="0.6" stopColor={T.colors.surface} stopOpacity="0.85" />
          <Stop offset="1" stopColor={T.colors.primary} stopOpacity="0.12" />
        </LinearGradient>
        <LinearGradient id="ridgeGlow" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={T.colors.primary} />
          <Stop offset="0.5" stopColor={T.colors.sapphire} />
          <Stop offset="1" stopColor={T.colors.accent} />
        </LinearGradient>
      </Defs>

      <Path d="M 0 0 H 300 V 180 H 0 Z" fill="url(#bgGlow)" />

      {/* Flowing wave ridges */}
      <Path
        d="M -10 135 C 70 150, 140 110, 310 140"
        fill="none"
        stroke="url(#ridgeGlow)"
        strokeWidth="1.5"
        strokeOpacity="0.10"
      />
      <Path
        d="M -10 150 C 60 170, 160 120, 310 160"
        fill="none"
        stroke="url(#ridgeGlow)"
        strokeWidth="2"
        strokeOpacity="0.14"
      />
      <Path
        d="M -10 165 C 80 180, 170 140, 310 175"
        fill="none"
        stroke="url(#ridgeGlow)"
        strokeWidth="2.5"
        strokeOpacity="0.20"
      />
      <Path
        d="M -10 180 C 50 190, 200 160, 310 185"
        fill="none"
        stroke="url(#ridgeGlow)"
        strokeWidth="3"
        strokeOpacity="0.26"
      />
      <Path
        d="M -10 200 C 90 210, 210 175, 310 205"
        fill="none"
        stroke="url(#ridgeGlow)"
        strokeWidth="3.5"
        strokeOpacity="0.18"
      />
    </Svg>
  );
}

function ArcGauge({
  score,
  label,
  rating,
}: {
  score: number | null;
  label: string;
  rating: string;
}) {
  const size = 260;
  const stroke = 18;
  const cx = size / 2;
  const cy = size / 2 + 4;
  const r = (size - stroke) / 2 - 8;
  const start = 135;
  const sweep = 270;
  const pct = score === null ? 0 : score / 100;
  const end = start + sweep * pct;
  const labelColor = gaugeLabelColor(rating);
  const gradientId = `gaugeGradient-${rating.replace(/\s+/g, '')}`;

  const gradientStops =
    rating === 'Excellent' || rating === 'No data yet'
      ? [
          { offset: '0', color: T.colors.primary },
          { offset: '0.5', color: T.colors.sapphire },
          { offset: '1', color: T.colors.accent },
        ]
      : rating === 'Good'
      ? [
          { offset: '0', color: T.colors.primary },
          { offset: '1', color: T.colors.primary },
        ]
      : rating === 'Fair'
      ? [
          { offset: '0', color: T.colors.warning },
          { offset: '1', color: T.colors.warning },
        ]
      : rating === 'Poor'
      ? [
          { offset: '0', color: T.colors.danger },
          { offset: '1', color: T.colors.danger },
        ]
      : [
          { offset: '0', color: T.colors.primary },
          { offset: '0.5', color: T.colors.sapphire },
          { offset: '1', color: T.colors.accent },
        ];

  const endPoint = polarToCartesian(cx, cy, r, end);

  return (
    <View style={styles.gaugeContainer}>
      <Svg width={size} height={size * 0.72} viewBox={`0 0 ${size} ${size * 0.72}`}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            {gradientStops.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </LinearGradient>
        </Defs>

        {/* Background track */}
        <Path
          d={describeArc(cx, cy, r, start, start + sweep)}
          fill="none"
          stroke={T.colors.border}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeOpacity={0.6}
        />

        {/* Outer bloom */}
        <Path
          d={describeArc(cx, cy, r, start, end)}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke * 3}
          strokeLinecap="round"
          strokeOpacity={0.12}
        />

        {/* Mid bloom */}
        <Path
          d={describeArc(cx, cy, r, start, end)}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke * 2}
          strokeLinecap="round"
          strokeOpacity={0.25}
        />

        {/* Crisp filled arc */}
        <Path
          d={describeArc(cx, cy, r, start, end)}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
        />

        {/* End dot halo */}
        <Circle cx={endPoint.x} cy={endPoint.y} r={12} fill={labelColor} opacity={0.18} />
        <Circle cx={endPoint.x} cy={endPoint.y} r={8} fill={labelColor} opacity={0.45} />
        <Circle cx={endPoint.x} cy={endPoint.y} r={4} fill={T.colors.textPrimary} />
      </Svg>
      <View style={styles.gaugeText}>
        <ThemedText style={styles.gaugeScore}>
          {score === null ? '—' : score}
        </ThemedText>
        <ThemedText style={[styles.gaugeLabel, { color: labelColor }]}>
          {label}
        </ThemedText>
        <Ionicons
          name="leaf-outline"
          size={22}
          color={labelColor}
          style={styles.gaugeIcon}
        />
      </View>
    </View>
  );
}

function ReefStabilityCard({
  score,
  label,
  rating,
  pumpStats,
  onPumpPress,
}: {
  score: number | null;
  label: string;
  rating: string;
  pumpStats: {
    pumpId: PumpId;
    today: number;
    sparkline: number[];
  }[];
  onPumpPress: (pumpId: PumpId) => void;
}) {
  const { width } = useWindowDimensions();
  const cardWidth = width - T.spacing.lg * 2;
  const backdropHeight = cardWidth * 0.55;

  return (
    <View style={styles.consistencyCard}>
      <View
        style={{
          ...StyleSheet.absoluteFillObject,
          borderRadius: T.radius.lg,
          overflow: 'hidden',
        }}>
        <CardBackdrop width={cardWidth} height={backdropHeight} />
      </View>

      <ThemedText style={styles.cardOverline}>DOSING CONSISTENCY</ThemedText>
      <ArcGauge score={score} label={label} rating={rating} />

      <View style={styles.miniStatsGrid}>
        {pumpStats.map((stat, index) => (
          <Pressable
            key={stat.pumpId}
            style={[
              styles.miniStatTile,
              index < pumpStats.length - 1 && styles.miniStatTileDivider,
            ]}
            onPress={() => onPumpPress(stat.pumpId)}>
            <ThemedText
              style={[styles.miniStatName, { color: PUMP_COLORS[stat.pumpId] }]}>
              {PUMP_DISPLAY_NAMES[stat.pumpId]}
            </ThemedText>
            <ThemedText style={styles.miniStatValue}>
              {stat.today.toFixed(1)}
              <ThemedText style={styles.miniStatUnit}> mL</ThemedText>
            </ThemedText>
            <View style={styles.miniStatSparkline}>
              <Sparkline
                data={stat.sparkline}
                color={PUMP_COLORS[stat.pumpId]}
              />
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function NextDoseCard({
  nextDose,
  onPress,
}: {
  nextDose: { schedule: DoseSchedule; date: Date } | null;
  onPress: () => void;
}) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const pumpName = nextDose
    ? PUMP_DISPLAY_NAMES[nextDose.schedule.pumpId]
    : '—';
  const volume = nextDose ? `${nextDose.schedule.volumeMl.toFixed(1)} mL` : '';
  const countdown = nextDose
    ? nextDose.date.getTime() > now.getTime()
      ? formatDuration(nextDose.date.getTime() - now.getTime())
      : 'Due now'
    : 'No upcoming dose';
  const timeStr = nextDose ? formatDateTime(nextDose.date) : '';

  return (
    <Pressable style={styles.nextDoseCard} onPress={onPress}>
      <View style={styles.nextDoseLeft}>
        <View
          style={[
            styles.nextDoseIcon,
            { backgroundColor: 'rgba(32, 227, 219, 0.12)' },
          ]}>
          <Ionicons name="water" size={22} color={T.colors.primary} />
        </View>
        <View>
          <ThemedText style={styles.nextDoseOverline}>NEXT DOSE</ThemedText>
          <View style={styles.nextDoseRow}>
            <ThemedText style={styles.nextDosePump}>{pumpName}</ThemedText>
            <ThemedText style={styles.nextDoseVolume}>{volume}</ThemedText>
          </View>
        </View>
      </View>
      <View style={styles.nextDoseRight}>
        <ThemedText style={styles.nextDoseCountdown}>{countdown}</ThemedText>
        <ThemedText style={styles.nextDoseTime}>{timeStr}</ThemedText>
        <Ionicons
          name="chevron-forward"
          size={20}
          color={T.colors.textMuted}
        />
      </View>
    </Pressable>
  );
}

function ConnectedDeviceCard({ offline, queueDepth }: { offline: boolean; queueDepth: number }) {
  return (
    <View style={styles.glassCard}>
      <ThemedText style={styles.cardOverline}>CONNECTED DEVICES</ThemedText>
      <View style={styles.deviceRow}>
        <View style={styles.deviceIconBg}>
          <ThemedText style={styles.deviceIconText}>A</ThemedText>
        </View>
        <View style={styles.deviceInfo}>
          <ThemedText style={styles.deviceName}>SHARLAY Dosing Pump</ThemedText>
          <ThemedText
            style={[
              styles.deviceStatus,
              offline ? { color: T.colors.danger } : { color: T.colors.success },
            ]}>
            {offline ? 'Offline' : 'Connected'}
          </ThemedText>
        </View>
        <View style={styles.deviceMeta}>
          <ThemedText style={styles.deviceMetaLabel}>Queue</ThemedText>
          <ThemedText style={styles.deviceMetaValue}>{queueDepth}</ThemedText>
        </View>
        <Ionicons
          name="chevron-forward"
          size={20}
          color={T.colors.textMuted}
        />
      </View>
    </View>
  );
}

function DoseModal({
  visible,
  pumpId,
  maxSingleDoseMl,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  pumpId: PumpId | null;
  maxSingleDoseMl: number;
  onClose: () => void;
  onConfirm: (pumpId: PumpId, volumeMl: number) => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const handleConfirm = () => {
    if (!pumpId) return;
    const volumeMl = parseFloat(input);
    if (Number.isNaN(volumeMl) || volumeMl <= 0) {
      setError('Enter a positive volume');
      return;
    }
    if (volumeMl > maxSingleDoseMl) {
      setError(`Max single dose is ${maxSingleDoseMl.toFixed(1)} mL`);
      return;
    }
    setError('');
    setInput('');
    onConfirm(pumpId, volumeMl);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <ThemedView style={styles.modalOverlay}>
        <ThemedView style={styles.modalContent}>
          <ThemedText style={styles.modalHeader}>
            Dose {pumpId?.toUpperCase() ?? ''}
          </ThemedText>
          <ThemedText style={styles.modalSubheader}>
            Max {maxSingleDoseMl.toFixed(1)} mL
          </ThemedText>

          <ThemedTextInput
            style={styles.modalInput}
            keyboardType="decimal-pad"
            placeholder="Volume (mL)"
            placeholderTextColor={T.colors.textMuted}
            value={input}
            onChangeText={setInput}
            autoFocus
          />

          {error ? (
            <ThemedText style={styles.modalError}>{error}</ThemedText>
          ) : null}

          <ThemedView style={styles.modalButtons}>
            <Pressable
              style={[styles.modalButton, styles.cancelButton]}
              onPress={onClose}>
              <ThemedText style={styles.cancelButtonText}>Cancel</ThemedText>
            </Pressable>
            <Pressable
              style={[styles.modalButton, styles.confirmButton]}
              onPress={handleConfirm}>
              <ThemedText style={styles.confirmButtonText}>Confirm</ThemedText>
            </Pressable>
          </ThemedView>
        </ThemedView>
      </ThemedView>
    </Modal>
  );
}

const PUMP_SHORT_NAMES: Record<PumpId, string> = {
  alk: 'Alk',
  ca: 'Ca',
  no3: 'NO3',
  po4: 'PO4',
};

function formatMissedWhen(scheduledFor: string): string {
  const d = new Date(scheduledFor);
  if (Number.isNaN(d.getTime())) return '—';
  const time = formatTime(d);
  const dayMs = 86_400_000;
  const diffDays = Math.round(
    (startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / dayMs,
  );
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

interface MissedCardState {
  loading: boolean;
  resolved?: 'dosed' | 'skipped';
  error?: string | null;
}

function MissedDosesModal({
  missedDoses,
  cardStates,
  onConfirm,
  onDismiss,
  onDecideLater,
}: {
  missedDoses: MissedDose[];
  cardStates: Record<string, MissedCardState>;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  onDecideLater: () => void;
}) {
  return (
    <Modal
      visible={missedDoses.length > 0}
      transparent
      animationType="fade"
      // Android hardware back: treat as "Decide later" (the only allowed
      // dismissal). There is no backdrop tap or swipe handler by design.
      onRequestClose={onDecideLater}>
      <ThemedView style={styles.modalOverlay}>
        <ThemedView style={[styles.modalContent, styles.missedContent]}>
          <ThemedText style={styles.modalHeader}>Missed doses</ThemedText>
          <ThemedText style={styles.missedSubheader}>
            These doses were missed while the device was off. Dosing them now
            is optional — your normal schedule is unaffected.
          </ThemedText>

          <ScrollView style={styles.missedList}>
            {missedDoses.map((missed) => {
              const card = cardStates[missed.id];
              const loading = card?.loading ?? false;
              const resolved = card?.resolved;
              return (
                <ThemedView key={missed.id} style={styles.missedItem}>
                  <ThemedView style={styles.missedRow}>
                    <ThemedText
                      style={[
                        styles.missedPump,
                        { color: PUMP_COLORS[missed.pumpId] },
                      ]}>
                      {PUMP_DISPLAY_NAMES[missed.pumpId] ?? missed.pumpId}
                    </ThemedText>
                    <ThemedText style={styles.missedVolume}>
                      {missed.volumeMl != null
                        ? `${missed.volumeMl.toFixed(2)} mL`
                        : '—'}
                    </ThemedText>
                  </ThemedView>
                  <ThemedText style={styles.missedTime}>
                    Scheduled {formatMissedWhen(missed.scheduledFor)}
                  </ThemedText>

                  {card?.error ? (
                    <ThemedText style={styles.missedError}>
                      {card.error}
                    </ThemedText>
                  ) : null}

                  {resolved ? (
                    <ThemedText
                      style={[
                        styles.missedResolved,
                        {
                          color:
                            resolved === 'dosed'
                              ? T.colors.success
                              : T.colors.textSecondary,
                        },
                      ]}>
                      {resolved === 'dosed' ? 'Dosed ✓' : 'Skipped'}
                    </ThemedText>
                  ) : (
                    <ThemedView style={styles.missedActions}>
                      <Pressable
                        style={[styles.modalButton, styles.skipButton]}
                        onPress={() => onDismiss(missed.id)}
                        disabled={loading}>
                        {loading ? (
                          <ActivityIndicator color={T.colors.danger} />
                        ) : (
                          <ThemedText
                            style={[
                              styles.missedSkipText,
                              styles.missedButtonText,
                            ]}>
                            Skip it
                          </ThemedText>
                        )}
                      </Pressable>
                      <Pressable
                        style={[styles.modalButton, styles.confirmButton]}
                        onPress={() => onConfirm(missed.id)}
                        disabled={loading}>
                        {loading ? (
                          <ActivityIndicator color={T.colors.background} />
                        ) : (
                          <ThemedText
                            style={[
                              styles.confirmButtonText,
                              styles.missedButtonText,
                            ]}>
                            Dose it
                          </ThemedText>
                        )}
                      </Pressable>
                    </ThemedView>
                  )}
                </ThemedView>
              );
            })}
          </ScrollView>

          <Pressable
            style={[styles.modalButton, styles.cancelButton, styles.decideLaterButton]}
            onPress={onDecideLater}>
            <ThemedText style={styles.cancelButtonText}>Decide later</ThemedText>
          </Pressable>
        </ThemedView>
      </ThemedView>
    </Modal>
  );
}

export default function DashboardScreen() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [modalPumpId, setModalPumpId] = useState<PumpId | null>(null);
  const [doseStates, setDoseStates] = useState<Record<string, DoseState>>({});
  const [missedDoses, setMissedDoses] = useState<MissedDose[]>([]);
  const [missedCardStates, setMissedCardStates] = useState<
    Record<string, MissedCardState>
  >({});
  // Ids the user deferred via "Decide later". Deferred entries stay pending
  // on the device; the modal reappears only when a NEW missed dose shows up.
  const [missedDeferredIds, setMissedDeferredIds] = useState<string[]>([]);

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

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      setLoading(true);
      setOffline(false);
      const [status, schedules, limits, missed, history] = await Promise.all([
        getStatus(baseUrl),
        getSchedules(baseUrl),
        getLimits(baseUrl),
        getMissedDoses(baseUrl),
        getHistory(baseUrl, { days: 30, limit: 10000, offset: 0 }),
      ]);
      setData({ status, schedules, limits, missedDoses: missed, history });
      setMissedDoses(missed);
    } catch {
      setOffline(true);
      setData(null);
      setMissedDoses([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [baseUrl]);

  useFocusEffect(
    useCallback(() => {
      load();
      const interval = setInterval(load, 30_000);
      return () => clearInterval(interval);
    }, [load]),
  );

  useFocusEffect(
    useCallback(() => {
      const activeIds = Object.entries(doseStates)
        .filter(([, s]) => s.status === 'queued' || s.status === 'running')
        .map(([id]) => id);
      if (activeIds.length === 0) return;

      const interval = setInterval(() => {
        load();
      }, 2_000);
      return () => clearInterval(interval);
    }, [doseStates, load]),
  );

  useMemo(() => {
    if (!data?.status) return;
    setDoseStates((prev) => {
      const next = { ...prev };
      for (const [pumpId, state] of Object.entries(prev)) {
        if (
          !state.eventId ||
          (state.status !== 'queued' && state.status !== 'running')
        ) {
          continue;
        }
        const event =
          data.status.currentDose?.id === state.eventId
            ? data.status.currentDose
            : data.status.queue?.find((e) => e.id === state.eventId);
        if (!event) {
          next[pumpId] = {
            status: 'done',
            message: 'Dose finished',
            eventId: state.eventId,
          };
        } else if (event.status === 'running') {
          next[pumpId] = {
            status: 'running',
            message: 'Dosing…',
            eventId: state.eventId,
          };
        } else if (event.status === 'queued') {
          const position =
            (data.status.queue?.findIndex((e) => e.id === state.eventId) ??
              -1) + 1;
          next[pumpId] = {
            status: 'queued',
            message: `Queued #${position}`,
            eventId: state.eventId,
          };
        } else {
          next[pumpId] = {
            status: 'done',
            message: `Dose ${event.status}`,
            eventId: state.eventId,
          };
        }
      }
      return next;
    });
  }, [data?.status]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const consistency = useMemo(() => {
    if (!data) return { score: null, label: 'No data yet' };
    return computeDosingConsistency(data.history, data.schedules);
  }, [data?.history, data?.schedules]);

  const pumpStats = useMemo(() => {
    if (!data) {
      return PUMP_ORDER.map((pumpId) => ({
        pumpId,
        today: 0,
        sparkline: [0, 0, 0, 0, 0, 0, 0],
      }));
    }
    return PUMP_ORDER.map((pumpId) => ({
      pumpId,
      today: computeTodayTotal(data.history, pumpId),
      sparkline: computePumpSparkline(data.history, pumpId, 7),
    }));
  }, [data?.history]);

  const nextDose = useMemo(
    () => (data ? computeNextDose(data.schedules) : null),
    [data?.schedules],
  );

  const handleMissedConfirm = async (id: string) => {
    if (!baseUrl) return;
    setMissedCardStates((s) => ({ ...s, [id]: { loading: true, error: null } }));
    try {
      await confirmMissedDose(baseUrl, id);
      resolveMissedCard(id, 'dosed');
    } catch (err) {
      // Keep the card; surface the error inline — never swallow it.
      setMissedCardStates((s) => ({
        ...s,
        [id]: {
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to dose',
        },
      }));
    }
  };

  const handleMissedDismiss = async (id: string) => {
    if (!baseUrl) return;
    setMissedCardStates((s) => ({ ...s, [id]: { loading: true, error: null } }));
    try {
      await dismissMissedDose(baseUrl, id);
      resolveMissedCard(id, 'skipped');
    } catch (err) {
      setMissedCardStates((s) => ({
        ...s,
        [id]: {
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to skip',
        },
      }));
    }
  };

  // Show the brief "Dosed ✓" / "Skipped" state, then remove the card. When
  // no pending entries remain the modal closes itself and the Dashboard
  // refreshes.
  const resolveMissedCard = (id: string, outcome: 'dosed' | 'skipped') => {
    setMissedCardStates((s) => ({
      ...s,
      [id]: { loading: false, resolved: outcome },
    }));
    setTimeout(() => {
      setMissedDoses((prev) => {
        const next = prev.filter((m) => m.id !== id);
        if (next.length === 0) load();
        return next;
      });
      setMissedCardStates((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
    }, 900);
  };

  const handleMissedDecideLater = () => {
    setMissedDeferredIds((prev) => [
      ...prev,
      ...missedDoses.map((m) => m.id).filter((id) => !prev.includes(id)),
    ]);
  };

  const visibleMissedDoses = missedDoses.filter(
    (m) => !missedDeferredIds.includes(m.id),
  );

  const handleDoseConfirm = async (pumpId: PumpId, volumeMl: number) => {
    if (!baseUrl) return;
    setModalPumpId(null);
    setDoseStates((s) => ({
      ...s,
      [pumpId]: { status: 'queued', message: 'Sending…' },
    }));

    try {
      const res = await postDose(baseUrl, { pumpId, volumeMl });
      // The engine starts the dose asynchronously; the 2s status sync
      // resolves the real running/queued state via the event id.
      const eventId = res.jobId;
      setDoseStates((s) => ({
        ...s,
        [pumpId]: {
          status: 'queued',
          message: 'Queued',
          eventId,
        },
      }));
      load();
    } catch (err) {
      setDoseStates((s) => ({
        ...s,
        [pumpId]: {
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed',
        },
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
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={T.colors.primary}
            colors={[T.colors.primary]}
          />
        }>
        <Header loading={loading && !refreshing} />
        <SystemStatusCard offline={offline} />
        <ReefStabilityCard
          score={consistency.score}
          label={consistency.label}
          rating={consistency.label}
          pumpStats={pumpStats}
          onPumpPress={setModalPumpId}
        />
        <NextDoseCard
          nextDose={nextDose}
          onPress={() => {
            if (nextDose) {
              setModalPumpId(nextDose.schedule.pumpId);
            }
          }}
        />
        <ConnectedDeviceCard
          offline={offline}
          queueDepth={data?.status.queueDepth ?? 0}
        />

        {Object.entries(doseStates).map(
          ([pumpId, state]) =>
            state.status !== 'idle' && (
              <View key={pumpId} style={styles.doseStateBanner}>
                <ThemedText
                  style={[
                    styles.doseStateText,
                    {
                      color:
                        state.status === 'error'
                          ? T.colors.danger
                          : state.status === 'done'
                          ? T.colors.success
                          : T.colors.primary,
                    },
                  ]}>
                  {PUMP_SHORT_NAMES[pumpId as PumpId]}: {state.message}
                </ThemedText>
              </View>
            ),
        )}
      </ScrollView>

      <DoseModal
        visible={modalPumpId !== null}
        pumpId={modalPumpId}
        maxSingleDoseMl={data?.limits.effective.maxSingleDoseMl ?? 5}
        onClose={() => setModalPumpId(null)}
        onConfirm={handleDoseConfirm}
      />

      <MissedDosesModal
        missedDoses={visibleMissedDoses}
        cardStates={missedCardStates}
        onConfirm={handleMissedConfirm}
        onDismiss={handleMissedDismiss}
        onDecideLater={handleMissedDecideLater}
      />
    </ThemedView>
  );
}

const glassBase: ViewStyle = {
  backgroundColor: 'rgba(17, 24, 39, 0.72)',
  borderRadius: T.radius.lg,
  borderWidth: 1,
  borderColor: T.colors.border,
  padding: T.spacing.lg,
  marginBottom: T.spacing.lg,
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: T.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    padding: T.spacing.lg,
    paddingBottom: T.spacing.hero,
  },
  header: {
    marginBottom: T.spacing.lg,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: T.spacing.sm,
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
  },
  wordmark: {
    fontSize: 20,
    lineHeight: 28,
    letterSpacing: 6,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  greetingRow: {
    gap: 2,
  },
  greetingLabel: {
    ...T.typography.body,
    color: T.colors.textSecondary,
  },
  greetingName: {
    ...T.typography.h2,
    color: T.colors.textPrimary,
  },
  glassCard: glassBase,
  consistencyCard: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.lg,
    borderWidth: 1,
    borderColor: T.colors.border,
    padding: T.spacing.lg,
    marginBottom: T.spacing.lg,
    overflow: 'hidden',
    ...T.shadows.card,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusLeft: {
    flex: 1,
    paddingRight: T.spacing.md,
  },
  statusLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    marginBottom: T.spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusOverline: {
    ...T.typography.caption,
    color: T.colors.textMuted,
  },
  statusTitle: {
    ...T.typography.h3,
    color: T.colors.textPrimary,
    marginBottom: 2,
  },
  statusSub: {
    ...T.typography.small,
    color: T.colors.textSecondary,
  },
  statusIconRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardOverline: {
    ...T.typography.caption,
    color: T.colors.textSecondary,
    letterSpacing: 1.2,
    marginBottom: T.spacing.md,
    zIndex: 1,
  },
  gaugeContainer: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: T.spacing.sm,
  },
  gaugeText: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: T.spacing.lg,
  },
  gaugeScore: {
    fontSize: 64,
    lineHeight: 72,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.light,
  },
  gaugeLabel: {
    ...T.typography.title,
    marginTop: -2,
  },
  gaugeIcon: {
    marginTop: T.spacing.sm,
  },
  miniStatsGrid: {
    flexDirection: 'row',
    marginTop: T.spacing.md,
    zIndex: 1,
  },
  miniStatTile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: T.spacing.sm,
    paddingHorizontal: 2,
  },
  miniStatTileDivider: {
    borderRightWidth: 1,
    borderRightColor: T.colors.border,
  },
  miniStatName: {
    ...T.typography.caption,
    marginBottom: 2,
    letterSpacing: 0.5,
  },
  miniStatValue: {
    fontSize: 24,
    lineHeight: 32,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  miniStatUnit: {
    ...T.typography.caption,
    color: T.colors.textMuted,
  },
  miniStatSparkline: {
    marginTop: T.spacing.sm,
  },
  nextDoseCard: {
    ...glassBase,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: T.spacing.md,
  },
  nextDoseLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
  },
  nextDoseIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextDoseOverline: {
    ...T.typography.caption,
    color: T.colors.textMuted,
    marginBottom: 2,
  },
  nextDoseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  nextDosePump: {
    ...T.typography.title,
    color: T.colors.textPrimary,
  },
  nextDoseVolume: {
    ...T.typography.body,
    color: T.colors.accent,
    fontFamily: T.typography.fontFamily.medium,
  },
  nextDoseRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  nextDoseCountdown: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  nextDoseTime: {
    ...T.typography.caption,
    color: T.colors.textMuted,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
  },
  deviceIconBg: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(32, 227, 219, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceIconText: {
    ...T.typography.h3,
    color: T.colors.primary,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  deviceStatus: {
    ...T.typography.caption,
  },
  deviceMeta: {
    alignItems: 'flex-end',
    marginRight: T.spacing.sm,
  },
  deviceMetaLabel: {
    ...T.typography.caption,
    color: T.colors.textMuted,
  },
  deviceMetaValue: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  doseStateBanner: {
    backgroundColor: 'rgba(32, 227, 219, 0.08)',
    borderRadius: T.radius.sm,
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  doseStateText: {
    ...T.typography.body,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: T.colors.overlay,
    padding: T.spacing.xxl,
  },
  modalContent: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.md,
    padding: T.spacing.xxl,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  modalHeader: {
    ...T.typography.h2,
    color: T.colors.textPrimary,
    marginBottom: T.spacing.xs,
  },
  modalSubheader: {
    ...T.typography.small,
    color: T.colors.textSecondary,
    marginBottom: T.spacing.lg,
  },
  modalInput: {
    height: 56,
    borderRadius: T.radius.sm,
    borderWidth: 1,
    borderColor: T.colors.borderActive,
    backgroundColor: T.colors.surfaceElevated,
    color: T.colors.textPrimary,
    paddingHorizontal: T.spacing.md,
    fontSize: T.typography.body.fontSize,
    fontFamily: T.typography.fontFamily.regular,
    marginBottom: T.spacing.md,
  },
  modalError: {
    ...T.typography.small,
    color: T.colors.danger,
    marginBottom: T.spacing.md,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: T.spacing.md,
    marginTop: T.spacing.md,
  },
  modalButton: {
    flex: 1,
    height: 48,
    borderRadius: T.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: T.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  cancelButtonText: {
    ...T.typography.title,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.medium,
  },
  confirmButton: {
    backgroundColor: T.colors.primary,
  },
  confirmButtonText: {
    ...T.typography.title,
    color: T.colors.background,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  missedContent: {
    maxHeight: '80%',
    borderColor: T.colors.warning,
    ...T.shadows.elevated,
  },
  missedSubheader: {
    ...T.typography.small,
    color: T.colors.textSecondary,
    marginBottom: T.spacing.lg,
  },
  missedList: {
    maxHeight: 400,
  },
  missedItem: {
    backgroundColor: T.colors.surfaceElevated,
    borderRadius: T.radius.sm,
    padding: T.spacing.lg,
    marginBottom: T.spacing.md,
    borderWidth: 1,
    borderColor: T.colors.border,
  },
  missedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: T.spacing.xs,
  },
  missedPump: {
    ...T.typography.title,
    textTransform: 'uppercase',
    fontFamily: T.typography.fontFamily.semiBold,
  },
  missedVolume: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  missedTime: {
    ...T.typography.small,
    color: T.colors.textMuted,
    marginBottom: T.spacing.md,
  },
  missedError: {
    ...T.typography.small,
    color: T.colors.danger,
    marginBottom: T.spacing.sm,
  },
  missedResolved: {
    ...T.typography.title,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  missedActions: {
    flexDirection: 'row',
    gap: T.spacing.md,
  },
  skipButton: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: T.colors.danger,
  },
  missedSkipText: {
    color: T.colors.danger,
  },
  missedButtonText: {
    ...T.typography.body,
  },
  decideLaterButton: {
    marginTop: T.spacing.sm,
  },
});
