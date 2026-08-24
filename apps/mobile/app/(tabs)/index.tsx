import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput, ThemedView } from '@/components/Themed';
import {
  getDeviceBaseUrl,
  getLimits,
  getSchedules,
  getStatus,
  postDose,
  type DoseResponse,
  type StatusResponse,
} from '@/src/api/client';
import { Theme } from '@/constants/Theme';
import {
  getNextDueDate,
  type DoseEvent,
  type DoseSchedule,
  type LimitsResponse,
  type PumpId,
  type PumpState,
} from '@reef/shared';

const T = Theme;
const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

interface DashboardData {
  status: StatusResponse;
  schedules: DoseSchedule[];
  limits: LimitsResponse;
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

function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <Pressable style={styles.offlineBanner} onPress={onRetry}>
      <ThemedText style={styles.offlineText}>
        Device offline — tap to retry
      </ThemedText>
    </Pressable>
  );
}

function ContainerBar({
  remaining,
  capacity,
}: {
  remaining: number;
  capacity: number;
}) {
  const pct = capacity > 0 ? Math.max(0, Math.min(1, remaining / capacity)) : 0;
  const isLow = pct < 0.15;
  return (
    <ThemedView style={styles.barTrack}>
      <View
        style={[
          styles.barFill,
          {
            width: `${pct * 100}%`,
            backgroundColor: isLow ? T.colors.danger : T.colors.primary,
          },
        ]}
      />
    </ThemedView>
  );
}

function PumpCard({
  pump,
  container,
  nextDose,
  limits,
  doseState,
  onDosePress,
}: {
  pump: PumpState;
  container: { capacityMl: number; remainingMl: number } | undefined;
  nextDose: Date | null;
  limits: LimitsResponse | null;
  doseState: DoseState;
  onDosePress: () => void;
}) {
  const capacity = container?.capacityMl ?? pump.containerRemainingMl;
  const remaining = container?.remainingMl ?? pump.containerRemainingMl;
  const lowContainer = capacity > 0 && remaining / capacity < 0.15;

  let stateBanner: React.ReactNode = null;
  if (doseState.status !== 'idle') {
    const color =
      doseState.status === 'error'
        ? T.colors.danger
        : doseState.status === 'done'
        ? T.colors.success
        : T.colors.primary;
    stateBanner = (
      <ThemedText style={[styles.doseState, { color }]}>
        {doseState.message}
      </ThemedText>
    );
  }

  return (
    <ThemedView style={styles.pumpCard}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText style={styles.pumpTitle}>{pump.pumpId}</ThemedText>
        <ThemedView
          style={[
            styles.badge,
            pump.calibrated ? styles.badgeSuccess : styles.badgeWarning,
          ]}>
          <ThemedText
            style={[
              styles.badgeText,
              pump.calibrated ? styles.badgeTextSuccess : styles.badgeTextWarning,
            ]}>
            {pump.calibrated ? 'Calibrated' : 'Uncalibrated'}
          </ThemedText>
        </ThemedView>
      </ThemedView>

      <ThemedView style={styles.metrics}>
        <ThemedView style={styles.metricRow}>
          <ThemedText style={styles.metricLabel}>Dosed today</ThemedText>
          <ThemedText style={styles.metricValue}>
            {pump.todayDoseMl.toFixed(2)} mL
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.metricRow}>
          <ThemedView style={styles.labelGroup}>
            <ThemedText style={styles.metricLabel}>Container</ThemedText>
            {lowContainer && (
              <ThemedText style={styles.lowLabel}>LOW</ThemedText>
            )}
          </ThemedView>
          <ThemedText style={styles.metricValue}>
            {remaining.toFixed(0)} / {capacity.toFixed(0)} mL
          </ThemedText>
        </ThemedView>
        <ContainerBar remaining={remaining} capacity={capacity} />

        <ThemedView style={styles.metricRow}>
          <ThemedText style={styles.metricLabel}>Next dose</ThemedText>
          <ThemedText style={styles.metricValue}>
            {nextDose ? formatDateTime(nextDose) : '—'}
          </ThemedText>
        </ThemedView>
      </ThemedView>

      {limits && (
        <ThemedText style={styles.limitText}>
          Max single dose: {limits.effective.maxSingleDoseMl.toFixed(1)} mL
        </ThemedText>
      )}

      <Pressable style={styles.doseButton} onPress={onDosePress}>
        <ThemedText style={styles.doseButtonText}>Dose now</ThemedText>
      </Pressable>

      {stateBanner}
    </ThemedView>
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

export default function DashboardScreen() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [modalPumpId, setModalPumpId] = useState<PumpId | null>(null);
  const [doseStates, setDoseStates] = useState<Record<string, DoseState>>({});

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

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      setLoading(true);
      setOffline(false);
      const [status, schedules, limits] = await Promise.all([
        getStatus(baseUrl),
        getSchedules(baseUrl),
        getLimits(baseUrl),
      ]);
      setData({ status, schedules, limits });
    } catch {
      setOffline(true);
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

  // Poll for dose completion when there are active doses.
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

  // Sync dose states against latest status.
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
            : data.status.queue.find((e) => e.id === state.eventId);
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
            data.status.queue.findIndex((e) => e.id === state.eventId) + 1;
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

  const sortedPumps = useMemo(() => {
    return PUMP_ORDER.map(
      (id) => data?.status.pumps.find((p) => p.pumpId === id),
    ).filter((p): p is PumpState => p !== undefined);
  }, [data?.status]);

  const containersByPump = useMemo(() => {
    const map = new Map<PumpId, { capacityMl: number; remainingMl: number }>();
    for (const c of data?.status.containers ?? []) {
      map.set(c.pumpId, c);
    }
    return map;
  }, [data?.status]);

  const nextDoseByPump = useMemo(() => {
    const map = new Map<PumpId, Date | null>();
    const now = new Date();
    for (const pumpId of PUMP_ORDER) {
      const pumpSchedules =
        data?.schedules.filter(
          (s) => s.pumpId === pumpId && s.enabled,
        ) ?? [];
      let next: Date | null = null;
      for (const schedule of pumpSchedules) {
        const candidate = getNextDueDate(schedule, now);
        if (candidate && (!next || candidate < next)) {
          next = candidate;
        }
      }
      map.set(pumpId, next);
    }
    return map;
  }, [data?.schedules]);

  const handleDoseConfirm = async (pumpId: PumpId, volumeMl: number) => {
    if (!baseUrl) return;
    setModalPumpId(null);
    setDoseStates((s) => ({
      ...s,
      [pumpId]: { status: 'queued', message: 'Sending…' },
    }));

    try {
      const res = await postDose(baseUrl, { pumpId, volumeMl });
      const eventId = res.event.id;
      setDoseStates((s) => ({
        ...s,
        [pumpId]: {
          status: res.event.status === 'running' ? 'running' : 'queued',
          message: res.event.status === 'running' ? 'Dosing…' : 'Queued',
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
      {offline && <OfflineBanner onRetry={load} />}

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
        <ThemedView style={styles.headerRow}>
          <ThemedView>
            <ThemedText style={styles.overline}>SHARLAY</ThemedText>
            <ThemedText style={styles.header}>Dashboard</ThemedText>
          </ThemedView>
          {loading && !refreshing && (
            <ActivityIndicator color={T.colors.primary} />
          )}
        </ThemedView>

        <ThemedView style={styles.summaryCard}>
          <ThemedView style={styles.summaryItem}>
            <ThemedText style={styles.summaryValue}>
              {data?.status.queueDepth ?? 0}
            </ThemedText>
            <ThemedText style={styles.summaryLabel}>Queue depth</ThemedText>
          </ThemedView>
          <ThemedView style={styles.summaryDivider} />
          <ThemedView style={styles.summaryItem}>
            <ThemedText style={styles.summaryValue}>
              {data?.limits.effective.systemVolumeLitres ?? '?'} L
            </ThemedText>
            <ThemedText style={styles.summaryLabel}>System volume</ThemedText>
          </ThemedView>
        </ThemedView>

        {sortedPumps.map((pump) => (
          <PumpCard
            key={pump.pumpId}
            pump={pump}
            container={containersByPump.get(pump.pumpId)}
            nextDose={nextDoseByPump.get(pump.pumpId) ?? null}
            limits={data?.limits ?? null}
            doseState={
              doseStates[pump.pumpId] ?? { status: 'idle', message: '' }
            }
            onDosePress={() => setModalPumpId(pump.pumpId)}
          />
        ))}
      </ScrollView>

      <DoseModal
        visible={modalPumpId !== null}
        pumpId={modalPumpId}
        maxSingleDoseMl={data?.limits.effective.maxSingleDoseMl ?? 5}
        onClose={() => setModalPumpId(null)}
        onConfirm={handleDoseConfirm}
      />
    </ThemedView>
  );
}

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
  offlineBanner: {
    backgroundColor: T.colors.danger,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.lg,
    alignItems: 'center',
  },
  offlineText: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  scrollContent: {
    padding: T.spacing.lg,
    paddingBottom: T.spacing.hero,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: T.spacing.lg,
  },
  overline: {
    ...T.typography.label,
    color: T.colors.textMuted,
    marginBottom: T.spacing.xs,
  },
  header: {
    ...T.typography.h1,
    color: T.colors.textPrimary,
  },
  summaryCard: {
    flexDirection: 'row',
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.md,
    padding: T.spacing.lg,
    marginBottom: T.spacing.lg,
    borderWidth: 1,
    borderColor: T.colors.border,
    ...T.shadows.card,
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryDivider: {
    width: 1,
    backgroundColor: T.colors.border,
    marginHorizontal: T.spacing.md,
  },
  summaryValue: {
    ...T.typography.h2,
    color: T.colors.primary,
  },
  summaryLabel: {
    ...T.typography.caption,
    color: T.colors.textSecondary,
    marginTop: T.spacing.xs,
  },
  pumpCard: {
    backgroundColor: T.colors.surface,
    borderRadius: T.radius.md,
    padding: T.spacing.lg,
    marginBottom: T.spacing.lg,
    borderWidth: 1,
    borderColor: T.colors.border,
    ...T.shadows.card,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: T.spacing.md,
  },
  pumpTitle: {
    ...T.typography.h2,
    color: T.colors.textPrimary,
    textTransform: 'uppercase',
  },
  badge: {
    paddingHorizontal: T.spacing.md,
    paddingVertical: T.spacing.xs,
    borderRadius: T.radius.pill,
  },
  badgeSuccess: {
    backgroundColor: 'rgba(0, 208, 132, 0.12)',
  },
  badgeWarning: {
    backgroundColor: 'rgba(255, 181, 71, 0.12)',
  },
  badgeText: {
    ...T.typography.caption,
  },
  badgeTextSuccess: {
    color: T.colors.success,
  },
  badgeTextWarning: {
    color: T.colors.warning,
  },
  metrics: {
    backgroundColor: T.colors.surfaceElevated,
    borderRadius: T.radius.sm,
    padding: T.spacing.md,
    marginBottom: T.spacing.md,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: T.spacing.sm,
  },
  labelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  metricLabel: {
    ...T.typography.small,
    color: T.colors.textSecondary,
  },
  metricValue: {
    ...T.typography.body,
    color: T.colors.textPrimary,
    fontFamily: T.typography.fontFamily.medium,
  },
  lowLabel: {
    ...T.typography.caption,
    color: T.colors.danger,
    fontFamily: T.typography.fontFamily.bold,
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: T.colors.border,
    overflow: 'hidden',
    marginBottom: T.spacing.md,
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
  limitText: {
    ...T.typography.small,
    color: T.colors.textMuted,
    marginBottom: T.spacing.md,
  },
  doseButton: {
    height: 52,
    borderRadius: T.radius.sm,
    backgroundColor: T.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...T.shadows.glow,
  },
  doseButtonText: {
    ...T.typography.title,
    color: T.colors.background,
    fontFamily: T.typography.fontFamily.semiBold,
  },
  doseState: {
    ...T.typography.small,
    marginTop: T.spacing.md,
    textAlign: 'center',
    fontFamily: T.typography.fontFamily.medium,
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
});
