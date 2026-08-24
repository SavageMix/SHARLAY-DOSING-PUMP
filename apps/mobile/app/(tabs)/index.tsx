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
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import {
  getNextDueDate,
  type DoseEvent,
  type DoseSchedule,
  type LimitsResponse,
  type PumpId,
  type PumpState,
} from '@reef/shared';

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
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
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
            backgroundColor: isLow ? Colors.danger : Colors.aqua,
          },
        ]}
      />
    </ThemedView>
  );
}

interface PumpCardProps {
  pump: PumpState;
  container: { capacityMl: number; remainingMl: number } | undefined;
  nextDose: Date | null;
  limits: LimitsResponse | null;
  doseState: DoseState;
  onDosePress: () => void;
}

function PumpCard({
  pump,
  container,
  nextDose,
  limits,
  doseState,
  onDosePress,
}: PumpCardProps) {
  const capacity = container?.capacityMl ?? pump.containerRemainingMl;
  const remaining = container?.remainingMl ?? pump.containerRemainingMl;
  const lowContainer = capacity > 0 && remaining / capacity < 0.15;

  let stateBanner: React.ReactNode = null;
  if (doseState.status === 'queued') {
    stateBanner = <ThemedText style={[styles.doseState, styles.infoText]}>{doseState.message}</ThemedText>;
  } else if (doseState.status === 'running') {
    stateBanner = <ThemedText style={[styles.doseState, styles.infoText]}>{doseState.message}</ThemedText>;
  } else if (doseState.status === 'done') {
    stateBanner = <ThemedText style={[styles.doseState, styles.successText]}>{doseState.message}</ThemedText>;
  } else if (doseState.status === 'error') {
    stateBanner = <ThemedText style={[styles.doseState, styles.errorText]}>{doseState.message}</ThemedText>;
  }

  return (
    <ThemedView style={styles.pumpCard}>
      <ThemedView style={styles.row}>
        <ThemedText style={styles.pumpTitle}>{pump.pumpId}</ThemedText>
        <ThemedText
          style={[
            styles.badge,
            pump.calibrated ? styles.success : styles.warning,
          ]}>
          {pump.calibrated ? 'Calibrated' : 'Uncalibrated'}
        </ThemedText>
      </ThemedView>

      <ThemedView style={styles.statRow}>
        <ThemedText style={styles.statLabel}>Dosed today</ThemedText>
        <ThemedText style={styles.statValue}>
          {pump.todayDoseMl.toFixed(2)} mL
        </ThemedText>
      </ThemedView>

      <ThemedView style={styles.statRow}>
        <ThemedView style={styles.containerLabelRow}>
          <ThemedText style={styles.statLabel}>Container</ThemedText>
          {lowContainer && (
            <ThemedText style={styles.lowText}>LOW</ThemedText>
          )}
        </ThemedView>
        <ThemedText style={styles.statValue}>
          {remaining.toFixed(0)} / {capacity.toFixed(0)} mL
        </ThemedText>
      </ThemedView>
      <ContainerBar remaining={remaining} capacity={capacity} />

      <ThemedView style={styles.statRow}>
        <ThemedText style={styles.statLabel}>Next dose</ThemedText>
        <ThemedText style={styles.statValue}>
          {nextDose ? formatDateTime(nextDose) : '—'}
        </ThemedText>
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

interface DoseModalProps {
  visible: boolean;
  pumpId: PumpId | null;
  maxSingleDoseMl: number;
  onClose: () => void;
  onConfirm: (pumpId: PumpId, volumeMl: number) => void;
}

function DoseModal({
  visible,
  pumpId,
  maxSingleDoseMl,
  onClose,
  onConfirm,
}: DoseModalProps) {
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
            placeholderTextColor={Colors.slate}
            value={input}
            onChangeText={setInput}
            autoFocus
          />

          {error ? (
            <ThemedText style={styles.errorText}>{error}</ThemedText>
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
    }, [])
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
    }, [load])
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
    }, [doseStates, load])
  );

  // Sync dose states against latest status.
  useMemo(() => {
    if (!data?.status) return;
    setDoseStates((prev) => {
      const next = { ...prev };
      for (const [pumpId, state] of Object.entries(prev)) {
        if (!state.eventId || (state.status !== 'queued' && state.status !== 'running')) {
          continue;
        }
        const event =
          data.status.currentDose?.id === state.eventId
            ? data.status.currentDose
            : data.status.queue.find((e) => e.id === state.eventId);
        if (!event) {
          // Event left queue and is not current -> likely completed/failed.
          // Check history is expensive; mark done optimistically.
          next[pumpId] = { status: 'done', message: 'Dose finished', eventId: state.eventId };
        } else if (event.status === 'running') {
          next[pumpId] = { status: 'running', message: 'Dosing…', eventId: state.eventId };
        } else if (event.status === 'queued') {
          next[pumpId] = { status: 'queued', message: `Queued #${data.status.queue.findIndex((e) => e.id === state.eventId) + 1}`, eventId: state.eventId };
        } else {
          next[pumpId] = { status: 'done', message: `Dose ${event.status}`, eventId: state.eventId };
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
      (id) => data?.status.pumps.find((p) => p.pumpId === id)
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
          (s) => s.pumpId === pumpId && s.enabled
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
          message:
            res.event.status === 'running' ? 'Dosing…' : 'Queued',
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
            tintColor={Colors.aqua}
            colors={[Colors.aqua]}
          />
        }>
        <ThemedView style={styles.headerRow}>
          <ThemedText style={styles.header}>Dashboard</ThemedText>
          {loading && !refreshing && (
            <ActivityIndicator color={Colors.aqua} />
          )}
        </ThemedView>

        <ThemedView style={styles.summaryCard}>
          <ThemedText style={styles.summaryText}>
            Queue depth: {data?.status.queueDepth ?? 0}
          </ThemedText>
          <ThemedText style={styles.summaryText}>
            System volume: {data?.limits.effective.systemVolumeLitres ?? '?'} L
          </ThemedText>
        </ThemedView>

        {sortedPumps.map((pump) => (
          <PumpCard
            key={pump.pumpId}
            pump={pump}
            container={containersByPump.get(pump.pumpId)}
            nextDose={nextDoseByPump.get(pump.pumpId) ?? null}
            limits={data?.limits ?? null}
            doseState={doseStates[pump.pumpId] ?? { status: 'idle', message: '' }}
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
    backgroundColor: Colors.obsidian,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offlineBanner: {
    backgroundColor: Colors.danger,
    padding: Spacing.md,
    alignItems: 'center',
  },
  offlineText: {
    ...Typography.body,
    color: Colors.pearl,
    fontWeight: '600',
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  header: {
    ...Typography.h1,
    color: Colors.pearl,
  },
  summaryCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  summaryText: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.xs,
  },
  pumpCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  pumpTitle: {
    ...Typography.h2,
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
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  containerLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  statLabel: {
    ...Typography.small,
    color: Colors.titanium,
  },
  statValue: {
    ...Typography.body,
    color: Colors.pearl,
  },
  lowText: {
    ...Typography.caption,
    color: Colors.danger,
    fontWeight: '700',
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.midnight,
    overflow: 'hidden',
    marginBottom: Spacing.md,
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
  limitText: {
    ...Typography.small,
    color: Colors.slate,
    marginBottom: Spacing.md,
  },
  doseButton: {
    height: 48,
    borderRadius: Radius.sm,
    backgroundColor: Colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doseButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  doseState: {
    ...Typography.small,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  infoText: {
    color: Colors.aqua,
  },
  successText: {
    color: Colors.success,
  },
  errorText: {
    color: Colors.danger,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: Spacing.lg,
  },
  modalContent: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.lg,
  },
  modalHeader: {
    ...Typography.h2,
    color: Colors.pearl,
    marginBottom: Spacing.xs,
  },
  modalSubheader: {
    ...Typography.small,
    color: Colors.titanium,
    marginBottom: Spacing.md,
  },
  modalInput: {
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
  modalButtons: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.md,
  },
  modalButton: {
    flex: 1,
    height: 48,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: Colors.midnight,
  },
  cancelButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
  confirmButton: {
    backgroundColor: Colors.blue,
  },
  confirmButtonText: {
    ...Typography.title,
    color: Colors.pearl,
  },
});
