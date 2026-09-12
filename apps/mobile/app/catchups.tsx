import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/core';
import Ionicons from '@expo/vector-icons/Ionicons';

import { OfflineCard } from '@/components/OfflineCard';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import {
  confirmMissedDoses,
  dismissMissedDoses,
  getDeviceBaseUrl,
  getHistory,
  getMissedDoses,
  getResolvedMissedDoses,
  getStatus,
  resolveDeviceBaseUrl,
  snoozeMissedDoses,
} from '@/src/api/client';
import { nextModalList, planDoseSelection, toggleChecked } from '@/src/lib/missed-decisions';
import {
  buildQueueSection,
  buildResolvedGroups,
  canCloseCatchups,
  groupMissedByPump,
  groupResolvedByDay,
  RESOLVED_WINDOW_DAYS,
  RESOLVED_WINDOW_HOURS,
} from '@/src/lib/catchups-page';
import type { ResolvedSlotRow } from '@/src/lib/catchups-page';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import type {
  CatchupQueueStatus,
  DoseEvent,
  MissedDose,
  PumpId,
} from '@reef/shared';

const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const PUMP_DISPLAY_NAMES: Record<PumpId, string> = {
  alk: 'Alkalinity',
  ca: 'Calcium',
  no3: 'Nitrate',
  po4: 'Phosphate',
};
const PUMP_COLORS: Record<PumpId, string> = {
  alk: Colors.aqua,
  ca: Colors.violet,
  no3: Colors.danger,
  po4: Colors.success,
};

interface MissedCardState {
  loading: boolean;
  resolved?: 'dosed' | 'skipped';
  error?: string | null;
  /** Entries the server refused to fire (cap exceeded), with the reason. */
  dropped?: Array<{ id: string; reason: string }>;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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

/** One resolved slot row — green for delivered, muted for skipped, red for failed. */
function ResolvedSlot({ row }: { row: ResolvedSlotRow }) {
  const when = formatMissedWhen(row.missedSlotIso);
  if (row.outcome === 'delivered') {
    return (
      <ThemedView style={styles.resolvedSlotRow}>
        <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
        <ThemedText style={styles.resolvedSlotText}>
          missed {when} ·{' '}
          {row.deliveredKnown
            ? `delivered ${row.ml.toFixed(2)} mL`
            : `${row.ml.toFixed(2)} mL requested`}
        </ThemedText>
      </ThemedView>
    );
  }
  if (row.outcome === 'failed') {
    return (
      <ThemedView style={styles.resolvedSlotRow}>
        <Ionicons name="alert-circle" size={16} color={Colors.danger} />
        <ThemedText style={[styles.resolvedSlotText, styles.failedText]}>
          missed {when} · failed{row.error ? `: ${row.error}` : ''}
        </ThemedText>
      </ThemedView>
    );
  }
  return (
    <ThemedView style={styles.resolvedSlotRow}>
      <Ionicons name="remove-circle-outline" size={16} color={Colors.danger} />
      <ThemedText style={[styles.resolvedSlotText, styles.skippedText]}>
        missed {when} · {row.outcome === 'expired' ? 'expired' : 'skipped'}
      </ThemedText>
    </ThemedView>
  );
}

export default function CatchupsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ forced?: string }>();
  // Forced re-prompt (snooze lapsed): no leaving until every pending entry
  // has an explicit decision. Voluntary visits may leave freely.
  const forced = params.forced === '1';

  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  // The decision list. FROZEN while non-empty: background polls must never
  // re-render an in-progress decision (a layout-shift mis-tap submitted a
  // batch on hardware once already).
  const [pending, setPending] = useState<MissedDose[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  // Display-only state — always replaced wholesale from the device.
  const [queue, setQueue] = useState<CatchupQueueStatus>({
    firing: null,
    queued: [],
  });
  const [fired, setFired] = useState<DoseEvent[]>([]);
  const [resolvedMisses, setResolvedMisses] = useState<MissedDose[]>([]);
  const [checkedIds, setCheckedIds] = useState<Record<string, boolean>>({});
  const [cardStates, setCardStates] = useState<Record<string, MissedCardState>>(
    {},
  );
  const [decideLaterError, setDecideLaterError] = useState('');

  useEffect(() => {
    let mounted = true;
    getDeviceBaseUrl().then((url) => {
      if (mounted) setBaseUrl(resolveDeviceBaseUrl(url));
    });
    return () => {
      mounted = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      const [missed, status, history, resolved] = await Promise.all([
        getMissedDoses(baseUrl, { includeSnoozed: true }),
        getStatus(baseUrl),
        getHistory(baseUrl, { days: RESOLVED_WINDOW_DAYS, limit: 200, offset: 0 }),
        getResolvedMissedDoses(baseUrl, RESOLVED_WINDOW_HOURS),
      ]);
      setOffline(false);
      // nextModalList keeps the current list while the user is deciding;
      // only an empty list (everything resolved) is refreshed.
      setPending((prev) => nextModalList(false, prev, missed, Date.now()));
      setPendingLoaded(true);
      setQueue(status.catchupQueue ?? { firing: null, queued: [] });
      setFired(history.events);
      setResolvedMisses(resolved);
    } catch {
      setOffline(true);
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, [load]);

  const canClose = canCloseCatchups(forced, pending.length);
  const pendingCountRef = useRef(pending.length);
  useEffect(() => {
    pendingCountRef.current = pending.length;
  }, [pending.length]);
  // Forced mode: block navigation away (back button, swipe, browser back)
  // until every pending entry has an explicit decision.
  usePreventRemove(!canClose, (e) => {
    // preventDefault is injected at runtime by the beforeRemove event emitter
    // (the library's own implementation calls it too) but is missing from
    // @react-navigation/core's callback type — hence the cast.
    (e as { preventDefault?: () => void }).preventDefault?.();
  });

  // Forced mode exit: once nothing pending remains, leave automatically.
  useEffect(() => {
    if (!forced || !pendingLoaded || pending.length > 0) return;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [forced, pendingLoaded, pending.length, router]);

  const queueSection = useMemo(
    () => buildQueueSection(queue.firing, queue.queued),
    [queue],
  );
  const resolvedGroups = useMemo(
    () => buildResolvedGroups(fired, resolvedMisses, PUMP_ORDER),
    [fired, resolvedMisses],
  );
  // Day groups for the expanded cards — device-local wall-clock slicing.
  const resolvedDaysByPump = useMemo(() => {
    const map: Record<string, ReturnType<typeof groupResolvedByDay>> = {};
    for (const g of resolvedGroups) map[g.pumpId] = groupResolvedByDay(g.rows, Date.now());
    return map;
  }, [resolvedGroups]);
  // Expanded/collapsed state is display-only — the model stays device-derived.
  const [expandedPumps, setExpandedPumps] = useState<Record<string, boolean>>(
    {},
  );
  const groups = useMemo(
    () => groupMissedByPump(pending, PUMP_ORDER),
    [pending],
  );

  const removeEntries = (ids: string[]) => {
    setPending((prev) => prev.filter((m) => !ids.includes(m.id)));
    setCheckedIds((s) => {
      const next = { ...s };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  const handleToggle = (id: string, value: boolean) => {
    // Selection state only — ticking can never submit.
    setCheckedIds((s) => toggleChecked(s, id, value));
  };

  const handleDoseSelected = async (pumpId: PumpId) => {
    if (!baseUrl) return;
    const pumpMisses = pending.filter((m) => m.pumpId === pumpId);
    const plan = planDoseSelection(pumpMisses, checkedIds);
    if (plan.selectedIds.length === 0) return;
    setCardStates((s) => ({ ...s, [pumpId]: { loading: true, error: null } }));
    try {
      const result = await confirmMissedDoses(baseUrl, plan.selectedIds);
      const selectedIds = new Set(plan.selectedIds);
      const remaining = pumpMisses.filter((m) => !selectedIds.has(m.id));
      const dropped =
        result.dropped && result.dropped.length > 0 ? result.dropped : undefined;
      if (remaining.length === 0) {
        // Whole pump resolved: brief "Dosed ✓", then the card comes out.
        setCardStates((s) => ({
          ...s,
          [pumpId]: { loading: false, resolved: 'dosed', dropped },
        }));
        setTimeout(() => {
          removeEntries(plan.selectedIds);
          load();
        }, dropped ? 2000 : 900);
      } else {
        // Partial selection: confirmed doses leave the card immediately; the
        // unticked entries remain for an explicit decision (dose or skip).
        setCardStates((s) => ({
          ...s,
          [pumpId]: { loading: false, error: null, dropped },
        }));
        removeEntries(plan.selectedIds);
        load();
      }
    } catch (err) {
      setCardStates((s) => ({
        ...s,
        [pumpId]: {
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to dose',
        },
      }));
    }
  };

  // Explicit per-dose dismissal — the ONLY way a single entry is skipped.
  const handleSkipDose = async (id: string) => {
    if (!baseUrl) return;
    const entry = pending.find((m) => m.id === id);
    if (!entry) return;
    setCardStates((s) => ({
      ...s,
      [entry.pumpId]: { loading: true, error: null },
    }));
    try {
      await dismissMissedDoses(baseUrl, [id]);
      removeEntries([id]);
      load();
    } catch (err) {
      setCardStates((s) => ({
        ...s,
        [entry.pumpId]: {
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to skip',
        },
      }));
    }
  };

  const handleSkipAll = async (pumpId: PumpId) => {
    if (!baseUrl) return;
    const pumpMisses = pending.filter((m) => m.pumpId === pumpId);
    if (pumpMisses.length === 0) return;
    setCardStates((s) => ({ ...s, [pumpId]: { loading: true, error: null } }));
    try {
      await dismissMissedDoses(
        baseUrl,
        pumpMisses.map((m) => m.id),
      );
      removeEntries(pumpMisses.map((m) => m.id));
      load();
    } catch (err) {
      setCardStates((s) => ({
        ...s,
        [pumpId]: {
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to skip',
        },
      }));
    }
  };

  const handleDecideLater = async () => {
    if (!baseUrl || forced) return;
    setDecideLaterError('');
    try {
      await snoozeMissedDoses(baseUrl);
    } catch (err) {
      // Keep the page open rather than pretending the snooze worked.
      setDecideLaterError(
        err instanceof Error ? err.message : 'Failed to snooze',
      );
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const close = () => {
    if (!canClose) return;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.headerRow}>
        {canClose ? (
          <Pressable style={styles.backButton} onPress={close}>
            <Ionicons name="chevron-back" size={22} color={Colors.pearl} />
          </Pressable>
        ) : (
          <View style={styles.backButton} />
        )}
        <ThemedText style={styles.header}>Catch-ups</ThemedText>
        {canClose ? (
          <Pressable onPress={close} accessibilityLabel="Close catch-ups">
            <ThemedText style={styles.doneText}>Done</ThemedText>
          </Pressable>
        ) : (
          <View style={styles.doneSpacer} />
        )}
      </ThemedView>

      <ScrollView contentContainerStyle={styles.scroll}>
        {offline ? <OfflineCard onRetry={() => load()} /> : null}

        {forced && pending.length > 0 ? (
          <ThemedView style={styles.forcedCard}>
            <ThemedText style={styles.forcedText}>
              These doses were missed while the device was off. Dosing them is
              optional — every entry needs an explicit decision (dose or
              skip) before you can continue.
            </ThemedText>
          </ThemedView>
        ) : null}

        {/* NEEDS DECISION ------------------------------------------------ */}
        {groups.length > 0 ? (
          <ThemedView style={styles.section}>
            <ThemedText style={styles.sectionTitle}>Needs decision</ThemedText>
            {groups.map(({ pumpId, entries }) => {
              const card = cardStates[pumpId];
              const loading = card?.loading ?? false;
              const resolved = card?.resolved;
              const selectedCount = entries.filter(
                (d) => checkedIds[d.id],
              ).length;
              return (
                <ThemedView key={pumpId} style={styles.pumpCard}>
                  <ThemedView style={styles.pumpCardHeader}>
                    <ThemedText
                      style={[styles.pumpName, { color: PUMP_COLORS[pumpId] }]}>
                      {PUMP_DISPLAY_NAMES[pumpId].toUpperCase()} —{' '}
                      {entries.length} missed dose
                      {entries.length === 1 ? '' : 's'}
                    </ThemedText>
                  </ThemedView>

                  {entries.map((missed) => (
                    <ThemedView key={missed.id} style={styles.doseRow}>
                      <Pressable
                        style={[
                          styles.checkbox,
                          checkedIds[missed.id] && styles.checkboxChecked,
                        ]}
                        onPress={() =>
                          handleToggle(missed.id, !checkedIds[missed.id])
                        }
                        disabled={loading || resolved != null}
                        accessibilityRole="checkbox"
                        accessibilityState={{
                          checked: !!checkedIds[missed.id],
                        }}>
                        {checkedIds[missed.id] ? (
                          <ThemedText style={styles.checkmark}>✓</ThemedText>
                        ) : null}
                      </Pressable>
                      <ThemedText style={styles.doseTime}>
                        Scheduled {formatMissedWhen(missed.scheduledFor)}
                      </ThemedText>
                      <ThemedText style={styles.doseVolume}>
                        {missed.volumeMl != null
                          ? `${missed.volumeMl.toFixed(2)} mL`
                          : '—'}
                      </ThemedText>
                      <Pressable
                        style={styles.rowSkip}
                        onPress={() => handleSkipDose(missed.id)}
                        disabled={loading || resolved != null}
                        accessibilityRole="button">
                        <ThemedText style={styles.rowSkipText}>Skip</ThemedText>
                      </Pressable>
                    </ThemedView>
                  ))}

                  {card?.error ? (
                    <ThemedText style={styles.errorText}>{card.error}</ThemedText>
                  ) : null}
                  {card?.dropped && card.dropped.length > 0 ? (
                    <ThemedText style={styles.errorText}>
                      {card.dropped.length} dose
                      {card.dropped.length === 1 ? '' : 's'} not dosed:{' '}
                      {card.dropped.map((d) => d.reason).join('; ')}
                    </ThemedText>
                  ) : null}
                  {resolved ? (
                    <ThemedText
                      style={[
                        styles.resolvedText,
                        {
                          color:
                            resolved === 'dosed'
                              ? Colors.success
                              : Colors.titanium,
                        },
                      ]}>
                      {resolved === 'dosed' ? 'Dosed ✓' : 'Skipped'}
                    </ThemedText>
                  ) : null}

                  <ThemedView style={styles.cardActions}>
                    <Pressable
                      style={[styles.button, styles.skipButton]}
                      onPress={() => handleSkipAll(pumpId)}
                      disabled={loading}>
                      {loading ? (
                        <ActivityIndicator color={Colors.danger} />
                      ) : (
                        <ThemedText
                          style={[styles.skipButtonText, styles.buttonText]}>
                          Skip all for {pumpId.toUpperCase()}
                        </ThemedText>
                      )}
                    </Pressable>
                    <Pressable
                      style={[
                        styles.button,
                        styles.confirmButton,
                        selectedCount === 0 && styles.buttonDisabled,
                      ]}
                      onPress={() => handleDoseSelected(pumpId)}
                      disabled={loading || selectedCount === 0}>
                      {loading ? (
                        <ActivityIndicator color={Colors.obsidian} />
                      ) : (
                        <ThemedText
                          style={[styles.confirmButtonText, styles.buttonText]}>
                          Dose selected ({selectedCount})
                        </ThemedText>
                      )}
                    </Pressable>
                  </ThemedView>
                </ThemedView>
              );
            })}
            {!forced ? (
              <>
                <Pressable
                  style={[styles.button, styles.decideLaterButton]}
                  onPress={handleDecideLater}>
                  <ThemedText style={styles.decideLaterText}>
                    Decide later
                  </ThemedText>
                </Pressable>
                {decideLaterError ? (
                  <ThemedText style={styles.errorText}>
                    {decideLaterError}
                  </ThemedText>
                ) : null}
              </>
            ) : null}
          </ThemedView>
        ) : (
          <ThemedView style={styles.section}>
            <ThemedText style={styles.sectionTitle}>Needs decision</ThemedText>
            <ThemedText style={styles.emptyText}>
              {pendingLoaded
                ? 'Nothing is waiting on a decision.'
                : 'Loading…'}
            </ThemedText>
          </ThemedView>
        )}

        {/* QUEUED / FIRING ----------------------------------------------- */}
        {queueSection.firing || queueSection.queued.length > 0 ? (
          <ThemedView style={styles.section}>
            <ThemedText style={styles.sectionTitle}>Queued / firing</ThemedText>
            {queueSection.firing ? (
              <ThemedView style={styles.firingRow}>
                <View style={styles.firingDot} />
                <ThemedText style={styles.firingText}>
                  Firing now — missed{' '}
                  {queueSection.firing.missedDoseScheduledFor
                    ? formatMissedWhen(queueSection.firing.missedDoseScheduledFor)
                    : '—'}{' '}
                  · {queueSection.firing.pumpId.toUpperCase()}
                </ThemedText>
              </ThemedView>
            ) : null}
            {queueSection.queued.map((q) => (
              <ThemedView key={q.missedDoseId} style={styles.queuedRow}>
                <ThemedText
                  style={[styles.queuedPump, { color: PUMP_COLORS[q.pumpId] }]}>
                  {q.pumpId.toUpperCase()}
                </ThemedText>
                <ThemedText style={styles.queuedText}>
                  missed{' '}
                  {q.missedDoseScheduledFor
                    ? formatMissedWhen(q.missedDoseScheduledFor)
                    : '—'}
                  {q.estimatedFireAt
                    ? ` · fires ~${formatTime(new Date(q.estimatedFireAt))}`
                    : ''}
                </ThemedText>
              </ThemedView>
            ))}
          </ThemedView>
        ) : null}

        {/* RESOLVED (last 24h) ------------------------------------------- */}
        <ThemedView style={styles.section}>
          <ThemedText style={styles.sectionTitle}>Resolved · 7 days</ThemedText>
          {resolvedGroups.every((g) => g.rows.length === 0) ? (
            <ThemedText style={styles.emptyText}>
              Nothing resolved in the last 7 days.
            </ThemedText>
          ) : (
            resolvedGroups.map((group) => {
              const expanded = !!expandedPumps[group.pumpId];
              const hasRows = group.rows.length > 0;
              const summary = `${PUMP_DISPLAY_NAMES[
                group.pumpId
              ].toUpperCase()} — ${group.deliveredCount} delivered · ${
                group.skippedCount
              } skipped${
                group.failedCount > 0 ? ` · ${group.failedCount} failed` : ''
              } · ${group.totalMl.toFixed(2)} mL total`;
              return (
                <ThemedView key={group.pumpId} style={styles.resolvedCard}>
                  <Pressable
                    style={styles.resolvedCardHeader}
                    disabled={!hasRows}
                    onPress={() =>
                      setExpandedPumps((s) => ({
                        ...s,
                        [group.pumpId]: !expanded,
                      }))
                    }
                    accessibilityRole={hasRows ? 'button' : undefined}>
                    <ThemedText
                      style={[
                        styles.resolvedSummary,
                        !hasRows && styles.resolvedSummaryEmpty,
                        { color: hasRows ? PUMP_COLORS[group.pumpId] : undefined },
                      ]}>
                      {summary}
                    </ThemedText>
                    {hasRows ? (
                      <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={Colors.titanium}
                      />
                    ) : null}
                  </Pressable>
                  {expanded
                    ? (resolvedDaysByPump[group.pumpId] ?? []).map((day) => (
                        <ThemedView key={day.dayKey}>
                          <ThemedText style={styles.dayHeader}>
                            {day.label}
                          </ThemedText>
                          {day.rows.map((row) => (
                            <ResolvedSlot key={row.key} row={row} />
                          ))}
                        </ThemedView>
                      ))
                    : null}
                </ThemedView>
              );
            })
          )}
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.obsidian,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
  },
  header: {
    ...Typography.h1,
    color: Colors.pearl,
  },
  doneText: {
    ...Typography.body,
    color: Colors.aqua,
    width: 44,
    textAlign: 'right',
  },
  doneSpacer: {
    width: 44,
  },
  scroll: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  forcedCard: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 181, 71, 0.4)',
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  forcedText: {
    ...Typography.small,
    color: Colors.warning,
  },
  section: {
    backgroundColor: Colors.abyss,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    ...Typography.body,
    color: Colors.titanium,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  emptyText: {
    ...Typography.small,
    color: Colors.slate,
  },
  pumpCard: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  pumpCardHeader: {
    marginBottom: Spacing.xs,
  },
  pumpName: {
    ...Typography.title,
  },
  doseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.slate,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: Colors.aqua,
    borderColor: Colors.aqua,
  },
  checkmark: {
    color: Colors.obsidian,
    fontSize: 14,
    fontWeight: '700',
  },
  doseTime: {
    ...Typography.small,
    color: Colors.titanium,
    flexShrink: 1,
  },
  doseVolume: {
    ...Typography.small,
    color: Colors.pearl,
    marginLeft: 'auto',
  },
  rowSkip: {
    paddingHorizontal: Spacing.xs,
    paddingVertical: 2,
  },
  rowSkipText: {
    ...Typography.small,
    color: Colors.danger,
  },
  errorText: {
    ...Typography.small,
    color: Colors.danger,
    marginTop: Spacing.sm,
  },
  resolvedText: {
    ...Typography.body,
    marginTop: Spacing.sm,
  },
  cardActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  button: {
    flex: 1,
    height: 44,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  skipButton: {
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  skipButtonText: {
    color: Colors.danger,
  },
  confirmButton: {
    backgroundColor: Colors.aqua,
  },
  confirmButtonText: {
    color: Colors.obsidian,
  },
  buttonText: {
    ...Typography.body,
  },
  decideLaterButton: {
    borderWidth: 1,
    borderColor: Colors.slate,
    marginTop: Spacing.xs,
  },
  decideLaterText: {
    ...Typography.body,
    color: Colors.titanium,
  },
  firingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: 'rgba(32, 227, 216, 0.08)',
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  firingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.aqua,
  },
  firingText: {
    ...Typography.body,
    color: Colors.aqua,
    flexShrink: 1,
  },
  queuedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  queuedPump: {
    ...Typography.body,
    width: 44,
  },
  queuedText: {
    ...Typography.small,
    color: Colors.titanium,
    flexShrink: 1,
  },
  resolvedCard: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  resolvedCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  resolvedSummary: {
    ...Typography.small,
    color: Colors.pearl,
    flexShrink: 1,
  },
  resolvedSummaryEmpty: {
    color: Colors.slate,
  },
  resolvedSlotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.sm,
  },
  resolvedSlotText: {
    ...Typography.small,
    color: Colors.pearl,
    flexShrink: 1,
  },
  dayHeader: {
    ...Typography.small,
    color: Colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: Spacing.sm,
  },
  failedText: {
    color: Colors.danger,
  },
  skippedText: {
    color: Colors.titanium,
  },
});
