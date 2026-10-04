import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { OfflineCard } from '@/components/OfflineCard';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import {
  cancelAllMissedDoses,
  cancelMissedDose,
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
import {
  nextModalList,
  planDoseSelection,
  sectionSelection,
  toggleChecked,
  toggleSelectAll,
} from '@/src/lib/missed-decisions';
import {
  buildQueueSection,
  buildResolvedGroups,
  groupMissedByPump,
  groupResolvedByDay,
  RESOLVED_WINDOW_DAYS,
  RESOLVED_WINDOW_HOURS,
  settleCardMutation,
  shouldSnoozeOnExit,
  splitPendingAndQueued,
} from '@/src/lib/catchups-page';
import type { ResolvedSlotRow } from '@/src/lib/catchups-page';
import {
  activeFindings,
  loadDismissedFindingIds,
  saveDismissedFindingIds,
} from '@/src/lib/integrity-findings';
import { Colors, Radius, Spacing, Typography } from '@/constants/Theme';
import type {
  CatchupQueueStatus,
  DoseEvent,
  IntegrityFinding,
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
  /** Brief success note, e.g. "2 skipped" after a partial skip-selected. */
  note?: string;
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
  if (row.outcome === 'expired') {
    return (
      <ThemedView style={styles.resolvedSlotRow}>
        <Ionicons name="remove-circle-outline" size={16} color={Colors.danger} />
        <ThemedText style={[styles.resolvedSlotText, styles.skippedText]}>
          missed {when} · expired — never delivered ({row.ml.toFixed(2)} mL)
        </ThemedText>
      </ThemedView>
    );
  }
  if (row.outcome === 'cancelled') {
    // Withdrawn after confirming — distinct from 'skipped' (refused while
    // pending) so "user changed their mind" is visible in History.
    return (
      <ThemedView style={styles.resolvedSlotRow}>
        <Ionicons name="arrow-undo-circle-outline" size={16} color={Colors.warning} />
        <ThemedText style={[styles.resolvedSlotText, styles.skippedText]}>
          missed {when} · cancelled — removed from queue, never dosed
        </ThemedText>
      </ThemedView>
    );
  }
  return (
    <ThemedView style={styles.resolvedSlotRow}>
      <Ionicons name="remove-circle-outline" size={16} color={Colors.danger} />
      <ThemedText style={[styles.resolvedSlotText, styles.skippedText]}>
        missed {when} · skipped
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
    remaining: 0,
    nextFireAt: null,
  });
  const [fired, setFired] = useState<DoseEvent[]>([]);
  const [resolvedMisses, setResolvedMisses] = useState<MissedDose[]>([]);
  // Boot-time integrity audit findings (from /api/status) and the ones the
  // user has read and dismissed. Dismissal is local display state only — the
  // device never modifies the underlying records.
  const [integrityFindings, setIntegrityFindings] = useState<IntegrityFinding[]>([]);
  const [dismissedFindingIds, setDismissedFindingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [checkedIds, setCheckedIds] = useState<Record<string, boolean>>({});
  const [cardStates, setCardStates] = useState<Record<string, MissedCardState>>(
    {},
  );
  // Confirmed catch-ups awaiting fire — the removable queued state. Fetched
  // with the pending list (includeConfirmed) but kept separate: these rows
  // have no checkboxes, only a Remove action.
  const [queued, setQueued] = useState<MissedDose[]>([]);
  // Remove-from-queue confirmation dialog: one entry, or the bulk clear.
  const [confirmCancel, setConfirmCancel] = useState<
    { kind: 'one'; id: string } | { kind: 'all' } | null
  >(null);
  const [cancelAllBusy, setCancelAllBusy] = useState(false);
  const [cancelAllNote, setCancelAllNote] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      const [missed, status, history, resolved] = await Promise.all([
        getMissedDoses(baseUrl, { includeSnoozed: true, includeConfirmed: true }),
        getStatus(baseUrl),
        getHistory(baseUrl, { days: RESOLVED_WINDOW_DAYS, limit: 200, offset: 0 }),
        getResolvedMissedDoses(baseUrl, RESOLVED_WINDOW_HOURS),
      ]);
      setOffline(false);
      // nextModalList keeps the current list while the user is deciding;
      // only an empty list (everything resolved) is refreshed — and the
      // fresh list is taken whole, snoozed entries included, so the page
      // shows exactly what the pending count reports. Confirmed (queued)
      // entries follow the same freeze discipline: they are display state
      // with a Remove action, never auto-mutated mid-decision.
      const split = splitPendingAndQueued(missed);
      setPending((prev) => nextModalList(false, prev, split.pending));
      setPendingLoaded(true);
      setQueued((prev) => nextModalList(false, prev, split.queued));
      setQueue(
        status.catchupQueue ?? {
          firing: null,
          queued: [],
          remaining: 0,
          nextFireAt: null,
        },
      );
      setFired(history.events);
      setResolvedMisses(resolved);
      setIntegrityFindings(status.integrityFindings ?? []);
    } catch {
      setOffline(true);
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, [load]);

  // Forced mode used to block navigation away (usePreventRemove) until every
  // entry was decided. That trapped users who needed to check the tank or
  // History first. Now both the header buttons and "Decide later" leave
  // freely; a forced exit snoozes 1h so the decision follows the user
  // instead of re-trapping them on the next poll. Nothing is ever dismissed
  // by leaving — entries stay pending and the Dashboard banner persists.

  // Forced mode exit: once nothing pending remains, leave automatically.
  useEffect(() => {
    if (!forced || !pendingLoaded || pending.length > 0) return;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [forced, pendingLoaded, pending.length, router]);

  const queueSection = useMemo(
    () =>
      buildQueueSection(queue.firing, queue.queued, {
        remaining: queue.remaining ?? 0,
        nextFireAt: queue.nextFireAt ?? null,
      }),
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
  const visibleFindings = useMemo(
    () => activeFindings(integrityFindings, dismissedFindingIds),
    [integrityFindings, dismissedFindingIds],
  );

  const dismissFinding = async (id: string) => {
    setDismissedFindingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      void saveDismissedFindingIds(next);
      return next;
    });
  };
  /**
   * NEEDS DECISION cards, three states in the same list: pending rows
   * (checkbox + skip), queued rows (confirmed catch-ups, removable), and
   * recently fired rows (read-only "Dosed ✓", from RESOLVED data — so a
   * catch-up that fires never disappears from the card, it just turns done).
   * A pump's card appears when it has ANY of the three.
   */
  const decisionGroups = useMemo(() => {
    const pendingByPump = new Map(
      groupMissedByPump(pending, PUMP_ORDER).map((g) => [g.pumpId, g.entries]),
    );
    const queuedByPump = new Map(
      groupMissedByPump(queued, PUMP_ORDER).map((g) => [g.pumpId, g.entries]),
    );
    const recentCutoffMs = Date.now() - 24 * 3_600_000;
    const firedByPump = new Map<PumpId, ResolvedSlotRow[]>();
    for (const g of resolvedGroups) {
      firedByPump.set(
        g.pumpId,
        g.rows.filter(
          (r) =>
            r.outcome === 'delivered' &&
            new Date(r.missedSlotIso).getTime() >= recentCutoffMs,
        ),
      );
    }
    return PUMP_ORDER.map((pumpId) => ({
      pumpId,
      pending: pendingByPump.get(pumpId) ?? [],
      queued: queuedByPump.get(pumpId) ?? [],
      fired: firedByPump.get(pumpId) ?? [],
    })).filter(
      (g) => g.pending.length > 0 || g.queued.length > 0 || g.fired.length > 0,
    );
  }, [pending, queued, resolvedGroups]);

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
    const outcome = await settleCardMutation(
      confirmMissedDoses(baseUrl, plan.selectedIds),
      'Failed to dose',
    );
    if (outcome.kind === 'noted') {
      // Reconciliation signal or failure — either way: clear the spinner,
      // show the server's message, refresh to current device state.
      setCardStates((s) => ({
        ...s,
        [pumpId]: { loading: false, error: outcome.note },
      }));
      load();
      return;
    }
    const result = outcome.value;
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
  };

  // Explicit per-dose dismissal — the ONLY way a single entry is skipped.
  // Invariant: every path out of here clears the card's loading state and
  // refreshes — a 409 means "state moved on", show the note and reconcile.
  const handleSkipDose = async (id: string) => {
    if (!baseUrl) return;
    const entry = pending.find((m) => m.id === id);
    if (!entry) return;
    const pumpId = entry.pumpId;
    setCardStates((s) => ({ ...s, [pumpId]: { loading: true, error: null } }));
    const outcome = await settleCardMutation(
      dismissMissedDoses(baseUrl, [id]),
      'Failed to skip',
    );
    setCardStates((s) => ({
      ...s,
      [pumpId]: { loading: false, error: outcome.kind === 'noted' ? outcome.note : null },
    }));
    if (outcome.kind === 'updated') removeEntries([id]);
    load();
  };

  // "Select all" — a pure selection-state toggle (HARD RULE: ticking never
  // submits). From 'none'/'some' it ticks the whole section, from 'all' it
  // clears it; skipping everything still needs the explicit "Skip selected"
  // press, so a single tap can never nuke a pump's list by accident.
  const handleSelectAll = (pumpId: PumpId) => {
    const ids = pending.filter((m) => m.pumpId === pumpId).map((m) => m.id);
    setCheckedIds((s) => toggleSelectAll(ids, s));
  };

  // Explicit batch dismissal of exactly the ticked pending entries. Only
  // PENDING ids are sent — never queued (confirmed) entries, which the
  // dismiss endpoint would refuse and 409 the whole batch. Invariant: every
  // path out clears the spinner and refreshes (the frozen-spinner bug).
  const handleSkipSelected = async (pumpId: PumpId) => {
    if (!baseUrl) return;
    const pumpMisses = pending.filter((m) => m.pumpId === pumpId);
    const plan = planDoseSelection(pumpMisses, checkedIds);
    if (plan.selectedIds.length === 0) return;
    setCardStates((s) => ({ ...s, [pumpId]: { loading: true, error: null } }));
    const outcome = await settleCardMutation(
      dismissMissedDoses(baseUrl, plan.selectedIds),
      'Failed to skip',
    );
    if (outcome.kind === 'noted') {
      setCardStates((s) => ({
        ...s,
        [pumpId]: { loading: false, error: outcome.note },
      }));
      load();
      return;
    }
    const selectedIds = new Set(plan.selectedIds);
    const remaining = pumpMisses.filter((m) => !selectedIds.has(m.id));
    if (remaining.length === 0) {
      // Whole pump skipped: brief "Skipped", then the card comes out.
      setCardStates((s) => ({
        ...s,
        [pumpId]: { loading: false, resolved: 'skipped' },
      }));
      setTimeout(() => {
        removeEntries(plan.selectedIds);
        load();
      }, 900);
    } else {
      // Partial selection: dismissed entries leave the card immediately with
      // a one-line note; the unticked entries remain for an explicit decision.
      setCardStates((s) => ({
        ...s,
        [pumpId]: { loading: false, note: `${plan.selectedIds.length} skipped` },
      }));
      removeEntries(plan.selectedIds);
      load();
    }
  };

  // Remove-from-queue flow. Submission happens ONLY via the explicit
  // "Remove" button in the confirmation dialog — tapping the ✕ merely opens
  // the dialog, exactly like the checkbox-never-submits rule for decisions.
  const handleConfirmCancel = async () => {
    if (!baseUrl || !confirmCancel) return;
    const target = confirmCancel;
    setConfirmCancel(null);

    if (target.kind === 'one') {
      const entry = queued.find((m) => m.id === target.id);
      const pumpId = entry?.pumpId;
      if (pumpId) {
        setCardStates((s) => ({ ...s, [pumpId]: { loading: true, error: null } }));
      }
      // A 409 ("already firing" / "already ended") is a reconciliation
      // signal, not a failure: the note carries the server's reason and the
      // refresh shows the true state. Loading clears on every path.
      const outcome = await settleCardMutation(
        cancelMissedDose(baseUrl, target.id),
        'Could not remove',
      );
      if (pumpId) {
        setCardStates((s) => ({ ...s, [pumpId]: { loading: false } }));
      }
      if (outcome.kind === 'updated') {
        setQueued((prev) => prev.filter((m) => m.id !== target.id));
      } else {
        setCancelAllNote(outcome.note);
      }
      load();
      return;
    }

    // Bulk: withdraw every queued catch-up. Doses already firing are left
    // to complete and are reported so the drain doesn't look partial.
    setCancelAllBusy(true);
    setCancelAllNote(null);
    try {
      const result = await cancelAllMissedDoses(baseUrl);
      setQueued((prev) =>
        prev.filter((m) => !result.cancelled.includes(m.id)),
      );
      setCancelAllNote(
        result.inFlight.length > 0
          ? `${result.inFlight.length} dose${result.inFlight.length === 1 ? '' : 's'} already firing — left to complete`
          : null,
      );
      load();
    } catch (err) {
      setCancelAllNote(
        err instanceof Error ? err.message : 'Failed to clear the queue',
      );
    } finally {
      setCancelAllBusy(false);
    }
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  // Leaving NEVER dismisses anything — entries stay pending and the decision
  // follows the user (Dashboard banner + Settings row). Forced-mode exits
  // snooze for 1h (see shouldSnoozeOnExit) so leaving doesn't immediately
  // re-open the forced screen on the next poll.
  const escapeForced = async () => {
    if (baseUrl && shouldSnoozeOnExit(forced)) {
      try {
        await snoozeMissedDoses(baseUrl);
      } catch {
        // The snooze couldn't be recorded — still leave (nothing is
        // destroyed either way); the forced screen simply reappears on a
        // later poll instead of after the 1h snooze.
      }
    }
    leave();
  };

  const handleDecideLater = () => {
    void escapeForced();
  };

  const close = () => {
    leave();
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.headerRow}>
        <Pressable
          style={styles.backButton}
          accessibilityLabel="Back"
          onPress={() => {
            // Forced exits snooze first so the user isn't re-trapped.
            if (forced) void escapeForced();
            else close();
          }}>
          <Ionicons name="chevron-back" size={22} color={Colors.pearl} />
        </Pressable>
        <ThemedText style={styles.header}>Catch-ups</ThemedText>
        <Pressable
          onPress={() => {
            if (forced) void escapeForced();
            else close();
          }}
          accessibilityLabel="Close catch-ups">
          <ThemedText style={styles.doneText}>Done</ThemedText>
        </Pressable>
      </ThemedView>

      <ScrollView contentContainerStyle={styles.scroll}>
        {offline ? <OfflineCard onRetry={() => load()} /> : null}

        {forced && pending.length > 0 ? (
          <ThemedView style={styles.forcedCard}>
            <ThemedText style={styles.forcedText}>
              These doses were missed while the device was off. Dosing them is
              optional — nothing is ever skipped unless you explicitly skip
              it. Decide now, or tap "Decide later" and come back within the
              hour: the entries stay pending and the dashboard banner keeps
              reminding you.
            </ThemedText>
          </ThemedView>
        ) : null}

        {/* NEEDS DECISION ------------------------------------------------ */}
        {decisionGroups.length > 0 ? (
          <ThemedView style={styles.section}>
            <ThemedText style={styles.sectionTitle}>Needs decision</ThemedText>
            {decisionGroups.map(({ pumpId, pending: entries, queued: queuedRows, fired: firedRows }) => {
              const card = cardStates[pumpId];
              const loading = card?.loading ?? false;
              const resolved = card?.resolved;
              const selectedCount = entries.filter(
                (d) => checkedIds[d.id],
              ).length;
              const sectionSel = sectionSelection(
                entries.map((d) => d.id),
                checkedIds,
              );
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

                  {/* Select all — tri-state header checkbox. Selection state
                      only; ticking never submits (HARD RULE). */}
                  {entries.length > 0 ? (
                    <Pressable
                      style={styles.selectAllRow}
                      onPress={() => handleSelectAll(pumpId)}
                      disabled={loading || resolved != null}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: sectionSel === 'all' }}
                      accessibilityLabel="Select all">
                      <ThemedView
                        style={[
                          styles.checkbox,
                          sectionSel === 'all' && styles.checkboxChecked,
                        ]}>
                        {sectionSel === 'all' ? (
                          <ThemedText style={styles.checkmark}>✓</ThemedText>
                        ) : sectionSel === 'some' ? (
                          <ThemedText style={styles.checkmarkPartial}>
                            –
                          </ThemedText>
                        ) : null}
                      </ThemedView>
                      <ThemedText style={styles.selectAllText}>
                        Select all
                      </ThemedText>
                    </Pressable>
                  ) : null}

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

                  {/* Queued catch-ups — confirmed, not yet fired, removable. */}
                  {queuedRows.map((missed) => (
                    <ThemedView key={missed.id} style={styles.queuedDoseRow}>
                      <Ionicons
                        name="time-outline"
                        size={16}
                        color={Colors.aqua}
                      />
                      <ThemedText style={styles.queuedDoseText}>
                        Queued · fires{' '}
                        {missed.confirmAfter
                          ? `~${formatTime(new Date(missed.confirmAfter))}`
                          : 'next'}{' '}
                        ·{' '}
                        {missed.volumeMl != null
                          ? `${missed.volumeMl.toFixed(2)} mL`
                          : '—'}
                      </ThemedText>
                      <Pressable
                        style={styles.rowRemove}
                        onPress={() =>
                          setConfirmCancel({ kind: 'one', id: missed.id })
                        }
                        disabled={loading}
                        accessibilityRole="button"
                        accessibilityLabel="Remove from queue">
                        <Ionicons
                          name="close-circle-outline"
                          size={20}
                          color={Colors.titanium}
                        />
                      </Pressable>
                    </ThemedView>
                  ))}

                  {/* Fired catch-ups — read-only done state, same card. */}
                  {firedRows.map((row) => (
                    <ThemedView key={row.key} style={styles.firedDoseRow}>
                      <ThemedText style={styles.firedDoseText}>
                        ✓ Dosed · missed{' '}
                        {formatMissedWhen(row.missedSlotIso)} ·{' '}
                        {row.deliveredKnown
                          ? `${row.ml.toFixed(2)} mL delivered`
                          : `${row.ml.toFixed(2)} mL`}
                      </ThemedText>
                    </ThemedView>
                  ))}

                  {card?.error ? (
                    <ThemedText style={styles.errorText}>{card.error}</ThemedText>
                  ) : null}
                  {card?.note ? (
                    <ThemedText style={styles.cardNote}>{card.note}</ThemedText>
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
                      style={[
                        styles.button,
                        styles.skipButton,
                        selectedCount === 0 && styles.buttonDisabled,
                      ]}
                      onPress={() => handleSkipSelected(pumpId)}
                      disabled={loading || resolved != null || selectedCount === 0}>
                      {loading ? (
                        <ActivityIndicator color={Colors.danger} />
                      ) : (
                        <ThemedText
                          style={[styles.skipButtonText, styles.buttonText]}>
                          Skip selected ({selectedCount})
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
                      disabled={loading || resolved != null || selectedCount === 0}>
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
            {queued.length > 0 ? (
              <Pressable
                style={[styles.button, styles.clearQueuedButton]}
                onPress={() => setConfirmCancel({ kind: 'all' })}
                disabled={cancelAllBusy}>
                {cancelAllBusy ? (
                  <ActivityIndicator color={Colors.danger} />
                ) : (
                  <ThemedText style={styles.clearQueuedText}>
                    Clear all queued ({queued.length})
                  </ThemedText>
                )}
              </Pressable>
            ) : null}
            {cancelAllNote ? (
              <ThemedText style={styles.cancelAllNote}>{cancelAllNote}</ThemedText>
            ) : null}
            <Pressable
              style={[styles.button, styles.decideLaterButton]}
              onPress={handleDecideLater}>
              <ThemedText style={styles.decideLaterText}>
                Decide later
              </ThemedText>
            </Pressable>
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
        {queueSection.firing ||
        queueSection.queued.length > 0 ||
        queueSection.remaining > 0 ? (
          <ThemedView style={styles.section}>
            <ThemedText style={styles.sectionTitle}>Queued / firing</ThemedText>
            {queueSection.remaining > 0 ? (
              <ThemedView style={styles.drainRow}>
                <ActivityIndicator color={Colors.aqua} size="small" />
                <ThemedText style={styles.drainText}>
                  Catching up: {queueSection.remaining} dose
                  {queueSection.remaining === 1 ? '' : 's'} remaining
                  {queueSection.nextFireAt
                    ? `, next ~${formatTime(new Date(queueSection.nextFireAt))}`
                    : ' — finishing current dose'}
                </ThemedText>
              </ThemedView>
            ) : null}
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

        {/* RECORD INTEGRITY ---------------------------------------------- */}
        {visibleFindings.length > 0 ? (
          <ThemedView style={styles.section}>
            <ThemedText style={styles.sectionTitle}>Record integrity</ThemedText>
            <ThemedText style={styles.findingsIntro}>
              The dosing record disagrees with itself in the ways listed below.
              Dosing is unaffected and nothing has been changed — these are
              reported for you to review.
            </ThemedText>
            {visibleFindings.map((finding) => (
              <ThemedView key={finding.id} style={styles.findingCard}>
                <Ionicons
                  name="warning"
                  size={18}
                  color={Colors.warning}
                />
                <ThemedText style={styles.findingText}>
                  {finding.message}
                </ThemedText>
                <Pressable
                  style={styles.findingDismiss}
                  onPress={() => dismissFinding(finding.id)}
                  accessibilityRole="button">
                  <ThemedText style={styles.findingDismissText}>
                    Dismiss
                  </ThemedText>
                </Pressable>
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
              }${
                group.cancelledCount > 0
                  ? ` · ${group.cancelledCount} cancelled`
                  : ''
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

      {/* REMOVE-FROM-QUEUE CONFIRMATION ---------------------------------- */}
      <Modal
        visible={confirmCancel !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmCancel(null)}>
        <ThemedView style={styles.confirmOverlay}>
          <ThemedView style={styles.confirmCard}>
            <ThemedText style={styles.confirmTitle}>
              {confirmCancel?.kind === 'all'
                ? `Remove ${queued.length} queued catch-up${queued.length === 1 ? '' : 's'}?`
                : 'Remove this catch-up?'}
            </ThemedText>
            <ThemedText style={styles.confirmBody}>
              {confirmCancel?.kind === 'all'
                ? 'They will not be dosed. Any dose already firing is left to complete.'
                : 'It will not be dosed. You can always dose this pump manually later.'}
            </ThemedText>
            <ThemedView style={styles.confirmActions}>
              <Pressable
                style={[styles.button, styles.keepButton]}
                onPress={() => setConfirmCancel(null)}
                accessibilityRole="button">
                <ThemedText style={styles.keepButtonText}>Keep</ThemedText>
              </Pressable>
              <Pressable
                style={[styles.button, styles.removeButton]}
                onPress={() => void handleConfirmCancel()}
                accessibilityRole="button">
                <ThemedText style={styles.removeButtonText}>Remove</ThemedText>
              </Pressable>
            </ThemedView>
          </ThemedView>
        </ThemedView>
      </Modal>
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
  checkmarkPartial: {
    color: Colors.titanium,
    fontSize: 14,
    fontWeight: '700',
  },
  selectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(198, 206, 216, 0.12)',
  },
  selectAllText: {
    ...Typography.small,
    color: Colors.titanium,
  },
  cardNote: {
    ...Typography.small,
    color: Colors.titanium,
    marginTop: Spacing.sm,
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
  queuedDoseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
    backgroundColor: 'rgba(32, 227, 216, 0.08)',
  },
  queuedDoseText: {
    ...Typography.small,
    color: Colors.aqua,
    flex: 1,
  },
  rowRemove: {
    padding: Spacing.xs,
  },
  firedDoseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.sm,
  },
  firedDoseText: {
    ...Typography.small,
    color: Colors.success,
    flex: 1,
  },
  clearQueuedButton: {
    borderWidth: 1,
    borderColor: Colors.danger,
    marginTop: Spacing.sm,
  },
  clearQueuedText: {
    ...Typography.body,
    color: Colors.danger,
  },
  cancelAllNote: {
    ...Typography.small,
    color: Colors.titanium,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  confirmCard: {
    backgroundColor: Colors.midnight,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: 'rgba(32, 227, 216, 0.2)',
    padding: Spacing.lg,
  },
  confirmTitle: {
    ...Typography.title,
    color: Colors.pearl,
    marginBottom: Spacing.sm,
  },
  confirmBody: {
    ...Typography.body,
    color: Colors.titanium,
    marginBottom: Spacing.lg,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  keepButton: {
    borderWidth: 1,
    borderColor: Colors.slate,
  },
  keepButtonText: {
    ...Typography.body,
    color: Colors.titanium,
  },
  removeButton: {
    backgroundColor: Colors.danger,
  },
  removeButtonText: {
    ...Typography.body,
    color: Colors.pearl,
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
  drainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: 'rgba(32, 227, 216, 0.08)',
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  drainText: {
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
  findingsIntro: {
    ...Typography.small,
    color: Colors.titanium,
    marginBottom: Spacing.sm,
  },
  findingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: 'rgba(255, 181, 71, 0.08)',
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 181, 71, 0.4)',
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  findingText: {
    ...Typography.small,
    color: Colors.pearl,
    flex: 1,
    flexShrink: 1,
  },
  findingDismiss: {
    paddingHorizontal: Spacing.xs,
    paddingVertical: 2,
  },
  findingDismissText: {
    ...Typography.small,
    color: Colors.titanium,
  },
  failedText: {
    color: Colors.danger,
  },
  skippedText: {
    color: Colors.titanium,
  },
});
