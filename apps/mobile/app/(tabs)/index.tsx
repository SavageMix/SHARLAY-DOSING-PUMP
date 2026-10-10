import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useFocusEffect, useRouter } from 'expo-router';
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
  getDeviceBaseUrl,
  getHistory,
  getLimits,
  getMissedDoses,
  getSchedules,
  getStatus,
  postDose,
  cancelDose,
  cancelMissedDose,
  skipNextDose,
  getContainers,
  refillReservoir,
  adjustReservoir,
  updateReservoir,
  resolveDeviceBaseUrl,
  type MissedDose,
  type StatusResponse,
} from '@/src/api/client';
import { Theme } from '@/constants/Theme';
import { describeCatchupQueue } from '@/src/lib/catchup-banner';
import { isBlockingMissedDose, settleCardMutation } from '@/src/lib/catchups-page';
import {
  reconcileDoseStates,
  type DoseTrackingState,
} from '@/src/lib/dose-states';
import { buildQueuePanel } from '@/src/lib/dose-queue';
import {
  nextDoseActionPlan,
  nextDoseSourceLabel,
  nextDoseSourceTag,
  resolveNextDose,
  type NextDose,
} from '@/src/lib/next-dose';
import {
  activeFindings,
  loadDismissedFindingIds,
} from '@/src/lib/integrity-findings';
import {
  formatDaysRemaining,
  formatLevel,
  levelBarState,
  lowBannerText,
  lowReservoirs,
  type LevelBarState,
} from '@/src/lib/reservoirs';
import {
  type ContainerStatus,
  type DoseEvent,
  type DoseQueueItem,
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

const LEVEL_BAR_COLORS: Record<LevelBarState, string> = {
  low: T.colors.danger,
  warning: T.colors.warning,
  ok: T.colors.success,
};

interface DashboardData {
  status: StatusResponse;
  schedules: DoseSchedule[];
  limits: LimitsResponse;
  history: HistoryResponse;
}

interface DoseState extends DoseTrackingState {}

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
  history: HistoryResponse,
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
  history: HistoryResponse,
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

function computeTodayTotal(history: HistoryResponse, pumpId: PumpId): number {
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

interface NextDoseDetails {
  pumpId: PumpId;
  volumeMl: number;
  fireAt: Date;
}

function nextDoseDetails(nextDose: NextDose): NextDoseDetails {
  return nextDose.kind === 'scheduled'
    ? {
        pumpId: nextDose.schedule.pumpId,
        volumeMl: nextDose.schedule.volumeMl,
        fireAt: nextDose.date,
      }
    : {
        pumpId: nextDose.item.pumpId,
        volumeMl: nextDose.item.amountMl,
        fireAt: nextDose.estimatedFireAt,
      };
}

function useNowTicker(): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
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
  nextDose: NextDose | null;
  onPress: () => void;
}) {
  const now = useNowTicker();

  if (!nextDose) {
    // Informational resting state: not pressable, no chevron.
    return (
      <View style={styles.nextDoseCard}>
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
            <ThemedText style={styles.nextDosePump}>
              No doses scheduled
            </ThemedText>
          </View>
        </View>
      </View>
    );
  }

  const details = nextDoseDetails(nextDose);
  const countdown =
    details.fireAt.getTime() > now.getTime()
      ? formatDuration(details.fireAt.getTime() - now.getTime())
      : 'Due now';

  return (
    <Pressable
      style={styles.nextDoseCard}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Next dose details">
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
            <ThemedText
              style={[
                styles.nextDosePump,
                { color: PUMP_COLORS[details.pumpId] },
              ]}>
              {PUMP_DISPLAY_NAMES[details.pumpId]}
            </ThemedText>
            <View style={styles.sourceTag}>
              <ThemedText style={styles.sourceTagText}>
                {nextDoseSourceTag(nextDose)}
              </ThemedText>
            </View>
            <ThemedText style={styles.nextDoseVolume}>
              {details.volumeMl.toFixed(1)} mL
            </ThemedText>
          </View>
        </View>
      </View>
      <View style={styles.nextDoseRight}>
        <ThemedText style={styles.nextDoseCountdown}>{countdown}</ThemedText>
        <ThemedText style={styles.nextDoseTime}>
          {formatDateTime(details.fireAt)}
        </ThemedText>
        <Ionicons
          name="chevron-forward"
          size={20}
          color={T.colors.textMuted}
        />
      </View>
    </Pressable>
  );
}

function NextDoseSheet({
  nextDose,
  busy,
  error,
  onClose,
  onSkip,
  onRemove,
}: {
  nextDose: NextDose;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSkip: () => void;
  onRemove: () => void;
}) {
  const now = useNowTicker();
  // Inline confirm step: one tap arms the destructive action, the second
  // tap (or the sheet closing) is required to actually fire it.
  const [confirming, setConfirming] = useState<'skip' | 'remove' | null>(null);

  const details = nextDoseDetails(nextDose);
  const plan = nextDoseActionPlan(nextDose);
  const countdown =
    details.fireAt.getTime() > now.getTime()
      ? formatDuration(details.fireAt.getTime() - now.getTime())
      : 'Due now';
  const removeLabel =
    nextDose.kind === 'queued' && nextDose.item.source === 'catchup'
      ? 'Remove catch-up'
      : 'Remove from queue';
  const confirmText =
    plan.kind === 'skip'
      ? 'Skip this dose? It will not fire and is recorded as skipped in History.'
      : `${removeLabel}? It won't be delivered.`;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close next dose details"
        />
        <View style={styles.sheetContent}>
          <View style={styles.sheetHandle} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.sheetHeaderRow}>
              <ThemedText
                style={[
                  styles.sheetTitle,
                  { color: PUMP_COLORS[details.pumpId] },
                ]}>
                {PUMP_DISPLAY_NAMES[details.pumpId]}
              </ThemedText>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}>
                <Ionicons name="close" size={22} color={T.colors.textMuted} />
              </Pressable>
            </View>

            <View style={styles.nextDoseSheetCountdownBlock}>
              <ThemedText style={styles.nextDoseSheetCountdown}>
                {countdown}
              </ThemedText>
              <ThemedText style={styles.nextDoseSheetTime}>
                {formatDateTime(details.fireAt)}
              </ThemedText>
            </View>

            <View style={styles.sheetDetailRow}>
              <ThemedText style={styles.sheetDetailLabel}>Volume</ThemedText>
              <ThemedText style={styles.sheetDetailValue}>
                {details.volumeMl.toFixed(1)} mL
              </ThemedText>
            </View>
            <View style={styles.sheetDetailRow}>
              <ThemedText style={styles.sheetDetailLabel}>Source</ThemedText>
              <ThemedText style={styles.sheetDetailValue}>
                {nextDoseSourceLabel(nextDose)}
              </ThemedText>
            </View>
            {nextDose.kind === 'queued' ? (
              <>
                <View style={styles.sheetDetailRow}>
                  <ThemedText style={styles.sheetDetailLabel}>
                    Queue position
                  </ThemedText>
                  <ThemedText style={styles.sheetDetailValue}>
                    #{nextDose.position}
                  </ThemedText>
                </View>
                <View style={styles.sheetDetailRow}>
                  <ThemedText style={styles.sheetDetailLabel}>
                    Estimated fire
                  </ThemedText>
                  <ThemedText style={styles.sheetDetailValue}>
                    {formatDateTime(details.fireAt)}
                  </ThemedText>
                </View>
              </>
            ) : null}

            {error ? (
              <ThemedText style={styles.modalError}>{error}</ThemedText>
            ) : null}

            {plan.kind === 'skip' ? (
              confirming === 'skip' ? (
                <View style={styles.cancelConfirmCard}>
                  <ThemedText style={styles.cancelConfirmText}>
                    {confirmText}
                  </ThemedText>
                  <View style={styles.cancelConfirmButtons}>
                    <Pressable
                      style={[styles.modalButton, styles.cancelButton]}
                      disabled={busy}
                      onPress={() => setConfirming(null)}>
                      <ThemedText style={styles.cancelButtonText}>
                        Cancel
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.modalButton,
                        styles.confirmButton,
                        busy && styles.confirmButtonDisabled,
                      ]}
                      disabled={busy}
                      onPress={onSkip}>
                      {busy ? (
                        <ActivityIndicator
                          color={T.colors.background}
                          size="small"
                        />
                      ) : null}
                      <ThemedText
                        style={[
                          styles.confirmButtonText,
                          busy && styles.confirmButtonTextDisabled,
                        ]}>
                        Skip dose
                      </ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  style={[
                    styles.modalButton,
                    styles.confirmButton,
                    busy && styles.confirmButtonDisabled,
                  ]}
                  disabled={busy}
                  onPress={() => setConfirming('skip')}>
                  <Ionicons
                    name="play-skip-forward-outline"
                    size={18}
                    color={T.colors.background}
                  />
                  <ThemedText style={styles.confirmButtonText}>
                    Skip this dose
                  </ThemedText>
                </Pressable>
              )
            ) : null}

            {plan.kind === 'remove' ? (
              confirming === 'remove' ? (
                <View style={styles.cancelConfirmCard}>
                  <ThemedText style={styles.cancelConfirmText}>
                    {confirmText}
                  </ThemedText>
                  <View style={styles.cancelConfirmButtons}>
                    <Pressable
                      style={[styles.modalButton, styles.cancelButton]}
                      disabled={busy}
                      onPress={() => setConfirming(null)}>
                      <ThemedText style={styles.cancelButtonText}>
                        Cancel
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.modalButton,
                        styles.cancelDoseButton,
                        busy && styles.confirmButtonDisabled,
                      ]}
                      disabled={busy}
                      onPress={onRemove}>
                      {busy ? (
                        <ActivityIndicator
                          color={T.colors.background}
                          size="small"
                        />
                      ) : null}
                      <ThemedText style={styles.cancelDoseButtonText}>
                        {removeLabel}
                      </ThemedText>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  style={[
                    styles.modalButton,
                    styles.cancelDoseButton,
                    busy && styles.confirmButtonDisabled,
                  ]}
                  disabled={busy}
                  onPress={() => setConfirming('remove')}>
                  <Ionicons
                    name="trash-outline"
                    size={18}
                    color={T.colors.background}
                  />
                  <ThemedText style={styles.cancelDoseButtonText}>
                    {removeLabel}
                  </ThemedText>
                </Pressable>
              )
            ) : null}

            {plan.kind === 'remove-unavailable' ? (
              <ThemedText style={styles.nextDoseSheetUnavailable}>
                This dose can't be withdrawn from here.
              </ThemedText>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ConnectedDeviceCard({
  offline,
  queueDepth,
  current,
  queueItems,
  onCancelRequest,
}: {
  offline: boolean;
  queueDepth: number;
  current: DoseEvent | null;
  queueItems: DoseQueueItem[];
  onCancelRequest: (jobId: string) => void;
}) {
  const [queueExpanded, setQueueExpanded] = useState(false);
  const panelRows = buildQueuePanel(current, queueItems);

  return (
    <View style={styles.glassCard}>
      <ThemedText style={styles.cardOverline}>CONNECTED DEVICES</ThemedText>
      <Pressable
        style={styles.deviceRow}
        onPress={() => setQueueExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: queueExpanded }}
        accessibilityLabel="SHARLAY Dosing Pump, toggle dose queue">
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
          name={queueExpanded ? 'chevron-down' : 'chevron-forward'}
          size={20}
          color={T.colors.textMuted}
        />
      </Pressable>

      {queueExpanded ? (
        panelRows.length === 0 ? (
          <ThemedText style={styles.queueEmpty}>Queue is empty</ThemedText>
        ) : (
          <View style={styles.queuePanel}>
            {panelRows.map((row) => {
              const fireAt = new Date(row.estimatedFireAt);
              const fireTime = Number.isNaN(fireAt.getTime())
                ? '—'
                : `~${formatTime(fireAt)}`;
              return (
                <View key={row.jobId} style={styles.queueRow}>
                  <View
                    style={[
                      styles.queuePumpDot,
                      { backgroundColor: PUMP_COLORS[row.pumpId] },
                    ]}
                  />
                  <ThemedText style={styles.queuePumpName}>
                    {PUMP_DISPLAY_NAMES[row.pumpId]}
                  </ThemedText>
                  <ThemedText style={styles.queueDetail}>
                    {row.amountMl.toFixed(2)} mL · {row.sourceLabel}
                  </ThemedText>
                  <ThemedText style={styles.queuePosition}>
                    {row.isCurrent ? 'Firing now' : `#${row.position}`}
                  </ThemedText>
                  <ThemedText style={styles.queueTime}>{fireTime}</ThemedText>
                  {row.canCancel ? (
                    <Pressable
                      style={styles.queueCancelButton}
                      onPress={() => onCancelRequest(row.jobId)}
                      accessibilityRole="button"
                      accessibilityLabel={`Cancel queued dose ${row.jobId}`}
                      hitSlop={8}>
                      <Ionicons
                        name="close"
                        size={16}
                        color={T.colors.danger}
                      />
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        )
      ) : null}
    </View>
  );
}

function DoseModal({
  visible,
  pumpId,
  maxSingleDoseMl,
  doseState,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  pumpId: PumpId | null;
  maxSingleDoseMl: number;
  doseState: DoseTrackingState | undefined;
  onClose: () => void;
  onConfirm: (pumpId: PumpId, volumeMl: number) => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const busy =
    doseState?.status === 'queued' || doseState?.status === 'running';
  const busyLabel =
    doseState?.status === 'running'
      ? 'Dosing…'
      : 'Queued — fires after current dose';

  const handleConfirm = () => {
    if (!pumpId || busy) return;
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
              style={[
                styles.modalButton,
                styles.confirmButton,
                busy && styles.confirmButtonDisabled,
              ]}
              disabled={busy}
              onPress={handleConfirm}>
              {busy ? (
                <ActivityIndicator color={T.colors.background} size="small" />
              ) : null}
              <ThemedText
                style={[
                  styles.confirmButtonText,
                  busy && styles.confirmButtonTextDisabled,
                ]}>
                {busy ? busyLabel : 'Confirm'}
              </ThemedText>
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

function LevelBar({
  state,
  fraction,
}: {
  state: LevelBarState;
  fraction: number;
}) {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return (
    <View style={styles.levelBarTrack}>
      <View
        style={[
          styles.levelBarFill,
          { width: `${pct}%`, backgroundColor: LEVEL_BAR_COLORS[state] },
        ]}
      />
    </View>
  );
}

function levelFraction(container: ContainerStatus): number {
  return container.capacityMl > 0
    ? container.currentMl / container.capacityMl
    : 0;
}

function ReservoirsCard({
  containers,
  error,
  onRetry,
  onSelect,
}: {
  containers: ContainerStatus[] | null;
  error: boolean;
  onRetry: () => void;
  onSelect: (pumpId: PumpId) => void;
}) {
  return (
    <View style={styles.glassCard}>
      <ThemedText style={styles.cardOverline}>RESERVOIRS</ThemedText>
      {error ? (
        <Pressable style={styles.reservoirErrorRow} onPress={onRetry}>
          <Ionicons name="alert-circle" size={18} color={T.colors.danger} />
          <ThemedText style={styles.reservoirErrorText}>
            Couldn't load reservoirs — tap to retry
          </ThemedText>
        </Pressable>
      ) : containers === null ? (
        <ActivityIndicator color={T.colors.primary} size="small" />
      ) : containers.length === 0 ? (
        <ThemedText style={styles.queueEmpty}>No reservoirs configured</ThemedText>
      ) : (
        <View style={styles.reservoirList}>
          {containers.map((container) => {
            const state = levelBarState(container);
            const low = state === 'low';
            return (
              <Pressable
                key={container.pumpId}
                style={styles.reservoirRow}
                onPress={() => onSelect(container.pumpId)}
                accessibilityRole="button"
                accessibilityLabel={`${container.name} reservoir, ${formatLevel(
                  container,
                )}`}>
                {low ? <View style={styles.reservoirLowAccent} /> : null}
                <View style={styles.reservoirRowMain}>
                  <View style={styles.reservoirNameRow}>
                    <ThemedText
                      style={[
                        styles.reservoirName,
                        low && { color: T.colors.danger },
                      ]}>
                      {container.name}
                    </ThemedText>
                    <ThemedText style={styles.reservoirLevelText}>
                      {formatLevel(container)}
                    </ThemedText>
                  </View>
                  <View style={styles.reservoirBarRow}>
                    <View style={styles.reservoirBar}>
                      <LevelBar
                        state={state}
                        fraction={levelFraction(container)}
                      />
                    </View>
                    <ThemedText
                      style={[
                        styles.reservoirDays,
                        low && { color: T.colors.danger },
                      ]}>
                      {formatDaysRemaining(container.daysRemaining)}
                    </ThemedText>
                  </View>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={T.colors.textMuted}
                />
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

function ReservoirSheet({
  container,
  busy,
  error,
  onClose,
  onRefillFull,
  onRefillPartial,
  onAdjust,
  onUpdate,
}: {
  container: ContainerStatus;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRefillFull: () => void;
  onRefillPartial: (volumeMl: number) => void;
  onAdjust: (currentMl: number) => void;
  onUpdate: (body: {
    name: string;
    capacityMl: number;
    lowThresholdMl: number;
  }) => void;
}) {
  const [confirmRefill, setConfirmRefill] = useState(false);
  const [partialInput, setPartialInput] = useState('');
  const [partialError, setPartialError] = useState('');
  const [adjustInput, setAdjustInput] = useState('');
  const [adjustError, setAdjustError] = useState('');
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [capacityInput, setCapacityInput] = useState('');
  const [thresholdInput, setThresholdInput] = useState('');
  const [editError, setEditError] = useState('');

  const state = levelBarState(container);
  const low = state === 'low';

  const handleRefillFull = () => {
    if (busy) return;
    setConfirmRefill(false);
    onRefillFull();
  };

  const handleRefillPartial = () => {
    if (busy) return;
    const volumeMl = parseFloat(partialInput);
    if (Number.isNaN(volumeMl) || volumeMl <= 0) {
      setPartialError('Enter a positive volume');
      return;
    }
    setPartialError('');
    onRefillPartial(volumeMl);
  };

  const handleAdjust = () => {
    if (busy) return;
    // 0 is allowed here: draining a reservoir dry is a legitimate correction.
    const currentMl = parseFloat(adjustInput);
    if (Number.isNaN(currentMl) || currentMl < 0) {
      setAdjustError('Enter 0 or a positive level');
      return;
    }
    setAdjustError('');
    onAdjust(currentMl);
  };

  const startEditing = () => {
    setNameInput(container.name);
    setCapacityInput(String(Math.round(container.capacityMl)));
    setThresholdInput(String(Math.round(container.lowThresholdMl)));
    setEditing(true);
  };

  const handleSaveEdit = () => {
    if (busy) return;
    const name = nameInput.trim();
    if (!name) {
      setEditError('Name cannot be empty');
      return;
    }
    const capacityMl = parseFloat(capacityInput);
    if (Number.isNaN(capacityMl) || capacityMl <= 0) {
      setEditError('Capacity must be a positive number');
      return;
    }
    const lowThresholdMl = parseFloat(thresholdInput);
    if (Number.isNaN(lowThresholdMl) || lowThresholdMl < 0) {
      setEditError('Threshold must be 0 or a positive number');
      return;
    }
    setEditError('');
    onUpdate({ name, capacityMl, lowThresholdMl });
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close reservoir details"
        />
        <View style={styles.sheetContent}>
          <View style={styles.sheetHandle} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.sheetHeaderRow}>
              <ThemedText style={styles.sheetTitle}>{container.name}</ThemedText>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}>
                <Ionicons name="close" size={22} color={T.colors.textMuted} />
              </Pressable>
            </View>

            <LevelBar state={state} fraction={levelFraction(container)} />
            <View style={styles.sheetStatsRow}>
              <ThemedText style={styles.sheetLevel}>
                {formatLevel(container)}
              </ThemedText>
              <ThemedText
                style={[
                  styles.sheetDays,
                  low && { color: T.colors.danger },
                ]}>
                {formatDaysRemaining(container.daysRemaining)}
              </ThemedText>
            </View>

            {error ? (
              <ThemedText style={styles.modalError}>{error}</ThemedText>
            ) : null}

            {confirmRefill ? (
              <View style={styles.cancelConfirmCard}>
                <ThemedText style={styles.cancelConfirmText}>
                  Refill {container.name} to full (
                  {Math.round(container.capacityMl)} mL)?
                </ThemedText>
                <View style={styles.cancelConfirmButtons}>
                  <Pressable
                    style={[styles.modalButton, styles.cancelButton]}
                    disabled={busy}
                    onPress={() => setConfirmRefill(false)}>
                    <ThemedText style={styles.cancelButtonText}>Cancel</ThemedText>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.modalButton,
                      styles.confirmButton,
                      busy && styles.confirmButtonDisabled,
                    ]}
                    disabled={busy}
                    onPress={handleRefillFull}>
                    {busy ? (
                      <ActivityIndicator color={T.colors.background} size="small" />
                    ) : null}
                    <ThemedText
                      style={[
                        styles.confirmButtonText,
                        busy && styles.confirmButtonTextDisabled,
                      ]}>
                      Refill
                    </ThemedText>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={[
                  styles.modalButton,
                  styles.confirmButton,
                  busy && styles.confirmButtonDisabled,
                ]}
                disabled={busy}
                onPress={() => setConfirmRefill(true)}>
                <Ionicons name="water" size={18} color={T.colors.background} />
                <ThemedText style={styles.confirmButtonText}>
                  Refill to full
                </ThemedText>
              </Pressable>
            )}

            <ThemedText style={styles.sheetSectionLabel}>
              PARTIAL REFILL
            </ThemedText>
            <View style={styles.sheetInputRow}>
              <ThemedTextInput
                style={[styles.modalInput, styles.sheetInput]}
                keyboardType="decimal-pad"
                placeholder="Volume (mL)"
                placeholderTextColor={T.colors.textMuted}
                value={partialInput}
                onChangeText={setPartialInput}
              />
              <Pressable
                style={[
                  styles.modalButton,
                  styles.sheetActionButton,
                  busy && styles.confirmButtonDisabled,
                ]}
                disabled={busy}
                onPress={handleRefillPartial}>
                <ThemedText style={styles.sheetActionButtonText}>Refill</ThemedText>
              </Pressable>
            </View>
            {partialError ? (
              <ThemedText style={styles.modalError}>{partialError}</ThemedText>
            ) : null}

            <ThemedText style={styles.sheetSectionLabel}>ADJUST LEVEL</ThemedText>
            <View style={styles.sheetInputRow}>
              <ThemedTextInput
                style={[styles.modalInput, styles.sheetInput]}
                keyboardType="decimal-pad"
                placeholder="Current level (mL)"
                placeholderTextColor={T.colors.textMuted}
                value={adjustInput}
                onChangeText={setAdjustInput}
              />
              <Pressable
                style={[
                  styles.modalButton,
                  styles.sheetActionButton,
                  busy && styles.confirmButtonDisabled,
                ]}
                disabled={busy}
                onPress={handleAdjust}>
                <ThemedText style={styles.sheetActionButtonText}>Set</ThemedText>
              </Pressable>
            </View>
            {adjustError ? (
              <ThemedText style={styles.modalError}>{adjustError}</ThemedText>
            ) : null}

            {editing ? (
              <View>
                <ThemedText style={styles.sheetSectionLabel}>
                  EDIT RESERVOIR
                </ThemedText>
                <ThemedTextInput
                  style={styles.modalInput}
                  placeholder="Name"
                  placeholderTextColor={T.colors.textMuted}
                  value={nameInput}
                  onChangeText={setNameInput}
                />
                <ThemedTextInput
                  style={styles.modalInput}
                  keyboardType="decimal-pad"
                  placeholder="Capacity (mL)"
                  placeholderTextColor={T.colors.textMuted}
                  value={capacityInput}
                  onChangeText={setCapacityInput}
                />
                <ThemedTextInput
                  style={styles.modalInput}
                  keyboardType="decimal-pad"
                  placeholder="Low threshold (mL)"
                  placeholderTextColor={T.colors.textMuted}
                  value={thresholdInput}
                  onChangeText={setThresholdInput}
                />
                {editError ? (
                  <ThemedText style={styles.modalError}>{editError}</ThemedText>
                ) : null}
                <View style={styles.modalButtons}>
                  <Pressable
                    style={[styles.modalButton, styles.cancelButton]}
                    disabled={busy}
                    onPress={() => setEditing(false)}>
                    <ThemedText style={styles.cancelButtonText}>Cancel</ThemedText>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.modalButton,
                      styles.confirmButton,
                      busy && styles.confirmButtonDisabled,
                    ]}
                    disabled={busy}
                    onPress={handleSaveEdit}>
                    {busy ? (
                      <ActivityIndicator color={T.colors.background} size="small" />
                    ) : null}
                    <ThemedText
                      style={[
                        styles.confirmButtonText,
                        busy && styles.confirmButtonTextDisabled,
                      ]}>
                      Save
                    </ThemedText>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={[styles.modalButton, styles.cancelButton]}
                disabled={busy}
                onPress={startEditing}>
                <Ionicons
                  name="create-outline"
                  size={18}
                  color={T.colors.textPrimary}
                />
                <ThemedText style={styles.cancelButtonText}>Edit details</ThemedText>
              </Pressable>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

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


export default function DashboardScreen() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [modalPumpId, setModalPumpId] = useState<PumpId | null>(null);
  const [doseStates, setDoseStates] = useState<Record<string, DoseState>>({});
  // Cancel-queued-dose dialog: the jobId awaiting confirmation, plus the
  // in-flight guard and the note surfaced when the server rejects (409 =
  // already firing/finished — a reconciliation signal, never a raw error).
  const [confirmCancelJobId, setConfirmCancelJobId] = useState<string | null>(
    null,
  );
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  // All pending missed-dose entries including snoozed ones. The Dashboard no
  // longer hosts the decision UI — the Catch-ups page does — but it stays the
  // alarm: the banner counts these, and snooze-lapsed (or never-snoozed)
  // entries redirect straight into the forced-decision flow.
  const [missedAll, setMissedAll] = useState<MissedDose[]>([]);
  // Per-pump reservoir levels (GET /api/containers). Null until the first
  // successful fetch; `containersError` drives the card's retry state.
  const [containers, setContainers] = useState<ContainerStatus[] | null>(null);
  const [containersError, setContainersError] = useState(false);
  // Reservoir detail sheet: which pump's sheet is open plus its in-flight
  // action guard and server-rejection note.
  const [sheetPumpId, setSheetPumpId] = useState<PumpId | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  // Low-reservoir banner dismissals: purely local, NEVER persisted (contrast:
  // integrity-findings dismissal). Reset on every fresh containers fetch, so
  // the banner comes back on the next refresh while the server still reports
  // the reservoir as low, and clears only when a refill/adjust moves the
  // level above the threshold server-side.
  const [dismissedLowPumpIds, setDismissedLowPumpIds] = useState<
    readonly PumpId[]
  >([]);
  // Integrity-audit findings the user has already read and dismissed
  // (device-side records are never touched by dismissal — this is local only).
  const [dismissedFindingIds, setDismissedFindingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Push the forced Catch-ups page at most once per blocking batch; reset
  // when a poll sees the blocking set cleared.
  const missedRedirectedRef = useRef(false);

  // Boot-time integrity audit findings not yet dismissed by the user.
  const integrityFindings = useMemo(
    () => activeFindings(data?.status.integrityFindings ?? [], dismissedFindingIds),
    [data?.status, dismissedFindingIds],
  );

  // Reservoirs the server reports as low, emptiest first.
  const lowContainers = useMemo(
    () => lowReservoirs(containers ?? []),
    [containers],
  );

  // Every fresh containers fetch (any poll, pull-refresh, or post-action
  // reload) resets the banner dismissals — dismissal is only ever local.
  useEffect(() => {
    setDismissedLowPumpIds([]);
  }, [containers]);

  const visibleLowContainers = lowContainers.filter(
    (c) => !dismissedLowPumpIds.includes(c.pumpId),
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getDeviceBaseUrl().then((url) => {
        if (mounted) setBaseUrl(resolveDeviceBaseUrl(url));
      });
      loadDismissedFindingIds().then((ids) => {
        if (mounted) setDismissedFindingIds(ids);
      });
      return () => {
        mounted = false;
      };
    }, []),
  );

  const router = useRouter();

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      setLoading(true);
      setOffline(false);
      const [status, schedules, limits, missed, history, containerList] =
        await Promise.all([
          getStatus(baseUrl),
          getSchedules(baseUrl),
          getLimits(baseUrl),
          getMissedDoses(baseUrl, { includeSnoozed: true }),
          getHistory(baseUrl, { days: 30, limit: 10000, offset: 0 }),
          // Reservoir levels ride the same refresh cycle (no second timer).
          // A containers failure must not take the whole dashboard offline
          // (older firmware lacks /api/containers) — it settles into the
          // Reservoirs card's own error state instead.
          getContainers(baseUrl).catch(() => null),
        ]);
      setData({ status, schedules, limits, history });
      setMissedAll(missed);
      setContainers(containerList);
      setContainersError(containerList === null);
      // Forced-decision flow: entries whose snooze has lapsed (or never had
      // one) open the Catch-ups page full-screen. Urgency must never require
      // the user to remember where the page lives — the alarm takes them
      // there. At most one push per blocking batch.
      const blocking = missed.some((m) => isBlockingMissedDose(m, Date.now()));
      if (blocking && !missedRedirectedRef.current) {
        missedRedirectedRef.current = true;
        router.push('/catchups?forced=1');
      } else if (!blocking) {
        missedRedirectedRef.current = false;
      }
    } catch {
      setOffline(true);
      setData(null);
      setContainersError(true);
      setMissedAll((prev) => (prev.length > 0 ? prev : []));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [baseUrl, router]);

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
      // Also poll fast while ANY dose is physically firing (e.g. a catch-up
      // fired by the scheduler) so the live indicator tracks it.
      const catchupActive =
        (data?.status.catchupQueue?.queued?.length ?? 0) > 0 ||
        data?.status.catchupQueue?.firing != null;
      if (activeIds.length === 0 && !data?.status.currentDose && !catchupActive)
        return;

      const interval = setInterval(() => {
        load();
      }, 2_000);
      return () => clearInterval(interval);
    }, [doseStates, data?.status, load]),
  );

  useMemo(() => {
    if (!data?.status) return;
    // /api/status + /api/history are the single source of truth: a dose is
    // only 'done' when the record says completed, and a cap rejection shows
    // the server's reason — never a tap-time guess (see lib/dose-states).
    setDoseStates((prev) =>
      reconcileDoseStates(prev, {
        currentDose: data.status.currentDose ?? null,
        queue: data.status.queue ?? [],
        queueItems: data.status.queueItems ?? [],
        history: data.history.events,
      }),
    );
  }, [data?.status, data?.history]);

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

  // Catch-up queue banner — 100% derived from /api/status's catchupQueue so a
  // page refresh mid-dose or mid-queue re-renders exactly the same state.
  const catchupBanner = useMemo(() => {
    const queue = data?.status.catchupQueue;
    return describeCatchupQueue(queue?.firing ?? null, queue?.queued ?? [], {
      formatSlot: formatMissedWhen,
      formatTime: (iso) => formatTime(new Date(iso)),
    });
  }, [data?.status]);

  const sheetContainer = useMemo(
    () => containers?.find((c) => c.pumpId === sheetPumpId) ?? null,
    [containers, sheetPumpId],
  );

  // Shared runner for every reservoir-sheet action. The server owns level
  // truth: on success close the sheet and let the next load repaint the card
  // and banner from the device's response; on failure surface the server's
  // own message inline and keep the sheet open.
  const runSheetAction = async (
    action: (url: string) => Promise<unknown>,
  ) => {
    if (!baseUrl || sheetBusy) return;
    const url = baseUrl;
    setSheetBusy(true);
    setSheetError(null);
    try {
      await action(url);
      setSheetPumpId(null);
      load();
    } catch (err) {
      setSheetError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSheetBusy(false);
    }
  };

  const handleDoseConfirm = async (pumpId: PumpId, volumeMl: number) => {
    if (!baseUrl) return;
    // Double-tap guard, second line of defence after the modal's disabled
    // Confirm: a pump already queued/running must not take another dose.
    const existing = doseStates[pumpId];
    if (existing?.status === 'queued' || existing?.status === 'running') return;
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

  const handleCancelDose = async () => {
    const jobId = confirmCancelJobId;
    if (!baseUrl || !jobId || cancelling) return;
    setCancelling(true);
    // Never throws: a 409 ("already firing" / "Dose already finished") is a
    // reconciliation signal — note it and refresh, exactly like the Catch-ups
    // page's settleCardMutation contract.
    const outcome = await settleCardMutation(
      cancelDose(baseUrl, jobId),
      'Could not cancel',
    );
    setCancelling(false);
    setConfirmCancelJobId(null);
    if (outcome.kind === 'noted') setCancelNote(outcome.note);
    // Server is source of truth: the cancelled dose lands in history as
    // status 'cancelled' and reconcile turns the pump idle.
    load();
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

        {visibleLowContainers.length > 0 ? (
          <View style={styles.lowBanner}>
            <View style={styles.lowBannerHeader}>
              <Ionicons name="alert-circle" size={18} color={T.colors.danger} />
              <ThemedText style={styles.lowBannerTitle}>
                Reservoir levels low
              </ThemedText>
              <Pressable
                style={styles.queueCancelButton}
                onPress={() =>
                  setDismissedLowPumpIds(lowContainers.map((c) => c.pumpId))
                }
                accessibilityRole="button"
                accessibilityLabel="Dismiss reservoir alert"
                hitSlop={8}>
                <Ionicons name="close" size={18} color={T.colors.textMuted} />
              </Pressable>
            </View>
            {visibleLowContainers.map((c) => (
              <ThemedText key={c.pumpId} style={styles.lowBannerLine}>
                {lowBannerText(c)}
              </ThemedText>
            ))}
          </View>
        ) : null}

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
          current={data?.status.currentDose ?? null}
          queueItems={data?.status.queueItems ?? []}
          onCancelRequest={setConfirmCancelJobId}
        />

        <ReservoirsCard
          containers={containers}
          error={containersError}
          onRetry={onRefresh}
          onSelect={setSheetPumpId}
        />

        {catchupBanner.visible ? (
          <Pressable
            style={styles.catchupBanner}
            onPress={() => router.push('/catchups')}>
            <Ionicons name="water" size={18} color={T.colors.primary} />
            <ThemedText style={styles.catchupBannerText}>
              {catchupBanner.text}
            </ThemedText>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={T.colors.primary}
            />
          </Pressable>
        ) : null}

        {integrityFindings.length > 0 ? (
          <Pressable
            style={styles.missedBanner}
            onPress={() => router.push('/catchups')}>
            <Ionicons
              name="warning"
              size={18}
              color={T.colors.warning}
            />
            <ThemedText style={styles.missedBannerText}>
              Record inconsistency detected — see Catch-ups
            </ThemedText>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={T.colors.warning}
            />
          </Pressable>
        ) : null}

        {missedAll.length > 0 ? (
          <Pressable
            style={styles.missedBanner}
            onPress={() => router.push('/catchups')}>
            <Ionicons
              name="alert-circle"
              size={18}
              color={T.colors.warning}
            />
            <ThemedText style={styles.missedBannerText}>
              {missedAll.length} missed dose
              {missedAll.length === 1 ? '' : 's'} awaiting your decision
            </ThemedText>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={T.colors.warning}
            />
          </Pressable>
        ) : null}

        {Object.entries(doseStates).map(
          ([pumpId, state]) =>
            state.status !== 'idle' && (
              <View key={pumpId} style={styles.doseStateBanner}>
                {state.status === 'queued' || state.status === 'running' ? (
                  <ActivityIndicator color={T.colors.primary} size="small" />
                ) : null}
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
                {state.status === 'queued' && state.eventId ? (
                  <Pressable
                    style={styles.queueCancelButton}
                    onPress={() =>
                      state.eventId && setConfirmCancelJobId(state.eventId)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Cancel queued dose ${state.eventId}`}
                    hitSlop={8}>
                    <Ionicons name="close" size={16} color={T.colors.danger} />
                  </Pressable>
                ) : null}
              </View>
            ),
        )}

        {cancelNote ? (
          <View style={styles.doseStateBanner}>
            <ThemedText style={[styles.doseStateText, styles.cancelNoteText]}>
              {cancelNote}
            </ThemedText>
            <Pressable
              style={styles.queueCancelButton}
              onPress={() => setCancelNote(null)}
              accessibilityRole="button"
              accessibilityLabel="Dismiss note"
              hitSlop={8}>
              <Ionicons name="close" size={16} color={T.colors.textMuted} />
            </Pressable>
          </View>
        ) : null}

        {confirmCancelJobId ? (
          <View style={styles.cancelConfirmCard}>
            <ThemedText style={styles.cancelConfirmText}>
              Cancel this dose? It won't be delivered.
            </ThemedText>
            <View style={styles.cancelConfirmButtons}>
              <Pressable
                style={[styles.modalButton, styles.cancelButton]}
                disabled={cancelling}
                onPress={() => setConfirmCancelJobId(null)}>
                <ThemedText style={styles.cancelButtonText}>Keep</ThemedText>
              </Pressable>
              <Pressable
                style={[styles.modalButton, styles.cancelDoseButton]}
                disabled={cancelling}
                onPress={handleCancelDose}>
                {cancelling ? (
                  <ActivityIndicator color={T.colors.background} size="small" />
                ) : null}
                <ThemedText style={styles.cancelDoseButtonText}>
                  Cancel dose
                </ThemedText>
              </Pressable>
            </View>
          </View>
        ) : null}
      </ScrollView>

      <DoseModal
        visible={modalPumpId !== null}
        pumpId={modalPumpId}
        maxSingleDoseMl={data?.limits.effective.maxSingleDoseMl ?? 5}
        doseState={modalPumpId ? doseStates[modalPumpId] : undefined}
        onClose={() => setModalPumpId(null)}
        onConfirm={handleDoseConfirm}
      />

      {sheetContainer ? (
        <ReservoirSheet
          key={sheetContainer.pumpId}
          container={sheetContainer}
          busy={sheetBusy}
          error={sheetError}
          onClose={() => setSheetPumpId(null)}
          onRefillFull={() =>
            runSheetAction((url) => refillReservoir(url, sheetContainer.pumpId))
          }
          onRefillPartial={(volumeMl) =>
            runSheetAction((url) =>
              refillReservoir(url, sheetContainer.pumpId, { volumeMl }),
            )
          }
          onAdjust={(currentMl) =>
            runSheetAction((url) =>
              adjustReservoir(url, sheetContainer.pumpId, currentMl),
            )
          }
          onUpdate={(body) =>
            runSheetAction((url) =>
              updateReservoir(url, sheetContainer.pumpId, body),
            )
          }
        />
      ) : null}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: T.spacing.sm,
    backgroundColor: 'rgba(32, 227, 219, 0.08)',
    borderRadius: T.radius.sm,
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  doseStateText: {
    ...T.typography.body,
    textAlign: 'center',
  },
  cancelNoteText: {
    color: T.colors.warning,
  },
  queuePanel: {
    marginTop: T.spacing.md,
    borderTopWidth: 1,
    borderTopColor: T.colors.border,
    paddingTop: T.spacing.sm,
    gap: T.spacing.xs,
  },
  queueEmpty: {
    ...T.typography.small,
    color: T.colors.textMuted,
    marginTop: T.spacing.md,
  },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    paddingVertical: T.spacing.xs,
  },
  queuePumpDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  queuePumpName: {
    ...T.typography.caption,
    color: T.colors.textPrimary,
    width: 72,
  },
  queueDetail: {
    ...T.typography.caption,
    color: T.colors.textSecondary,
    flex: 1,
  },
  queuePosition: {
    ...T.typography.caption,
    color: T.colors.primary,
  },
  queueTime: {
    ...T.typography.caption,
    color: T.colors.textMuted,
  },
  queueCancelButton: {
    padding: 2,
  },
  cancelConfirmCard: {
    backgroundColor: 'rgba(255, 77, 90, 0.08)',
    borderRadius: T.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 90, 0.35)',
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
    gap: T.spacing.md,
  },
  cancelConfirmText: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    textAlign: 'center',
  },
  cancelConfirmButtons: {
    flexDirection: 'row',
    gap: T.spacing.md,
  },
  cancelDoseButton: {
    flex: 1,
    height: 48,
    borderRadius: T.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: T.spacing.sm,
    backgroundColor: T.colors.danger,
  },
  cancelDoseButtonText: {
    ...T.typography.title,
    color: T.colors.background,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonTextDisabled: {
    fontFamily: T.typography.fontFamily.regular,
  },
  catchupBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    backgroundColor: 'rgba(32, 227, 219, 0.08)',
    borderRadius: T.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 219, 0.25)',
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  catchupBannerText: {
    ...T.typography.body,
    color: T.colors.primary,
    flex: 1,
  },
  missedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    backgroundColor: 'rgba(255, 181, 71, 0.10)',
    borderRadius: T.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 181, 71, 0.35)',
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  missedBannerText: {
    ...T.typography.body,
    color: T.colors.warning,
    flex: 1,
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
    flexDirection: 'row',
    gap: T.spacing.sm,
  },
  confirmButtonText: {
    ...T.typography.title,
    color: T.colors.background,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  levelBarTrack: {
    height: 8,
    borderRadius: T.radius.pill,
    backgroundColor: T.colors.surfaceElevated,
    overflow: 'hidden',
  },
  levelBarFill: {
    height: '100%',
    borderRadius: T.radius.pill,
  },
  reservoirList: {
    gap: T.spacing.md,
  },
  reservoirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  reservoirLowAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: T.radius.pill,
    backgroundColor: T.colors.danger,
  },
  reservoirRowMain: {
    flex: 1,
    gap: T.spacing.xs,
  },
  reservoirNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.sm,
  },
  reservoirName: {
    ...T.typography.small,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reservoirLevelText: {
    ...T.typography.caption,
    color: T.colors.textSecondary,
  },
  reservoirBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  reservoirBar: {
    flex: 1,
  },
  reservoirDays: {
    ...T.typography.caption,
    color: T.colors.textMuted,
    minWidth: 88,
    textAlign: 'right',
  },
  reservoirErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  reservoirErrorText: {
    ...T.typography.small,
    color: T.colors.danger,
    flex: 1,
  },
  lowBanner: {
    backgroundColor: 'rgba(255, 77, 90, 0.10)',
    borderRadius: T.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 90, 0.35)',
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
    gap: T.spacing.xs,
  },
  lowBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    marginBottom: 2,
  },
  lowBannerTitle: {
    ...T.typography.caption,
    color: T.colors.danger,
    flex: 1,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  lowBannerLine: {
    ...T.typography.small,
    color: T.colors.textPrimary,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: T.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: T.colors.surface,
    borderTopLeftRadius: T.radius.md,
    borderTopRightRadius: T.radius.md,
    borderWidth: 1,
    borderColor: T.colors.border,
    borderBottomWidth: 0,
    padding: T.spacing.xxl,
    paddingBottom: T.spacing.hero,
    maxHeight: '88%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: T.colors.borderActive,
    marginBottom: T.spacing.md,
  },
  sheetHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: T.spacing.md,
  },
  sheetTitle: {
    ...T.typography.h2,
    color: T.colors.textPrimary,
  },
  sheetStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: T.spacing.sm,
    marginBottom: T.spacing.lg,
  },
  sheetLevel: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  sheetDays: {
    ...T.typography.small,
    color: T.colors.textSecondary,
  },
  sheetSectionLabel: {
    ...T.typography.caption,
    color: T.colors.textMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: T.spacing.lg,
    marginBottom: T.spacing.sm,
  },
  sheetInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
  },
  sheetInput: {
    flex: 1,
    marginBottom: 0,
  },
  sheetActionButton: {
    flex: 0,
    width: 104,
    height: 56,
    backgroundColor: T.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: T.colors.borderActive,
  },
  sheetActionButtonText: {
    ...T.typography.title,
    color: T.colors.primary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
});
