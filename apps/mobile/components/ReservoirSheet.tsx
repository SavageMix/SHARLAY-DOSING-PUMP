import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/ThemedText';
import { ThemedTextInput } from '@/components/Themed';
import { Theme } from '@/constants/Theme';
import {
  additiveRefillTarget,
  formatDaysRemaining,
  formatLevel,
  levelBarState,
  type LevelBarState,
} from '@/src/lib/reservoirs';
import type { ContainerStatus } from '@reef/shared';

const T = Theme;

const LEVEL_BAR_COLORS: Record<LevelBarState, string> = {
  low: T.colors.danger,
  warning: T.colors.warning,
  ok: T.colors.success,
};

export function LevelBar({
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

export function levelFraction(container: ContainerStatus): number {
  return container.capacityMl > 0
    ? container.currentMl / container.capacityMl
    : 0;
}

export function ReservoirSheet({
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
  const insets = useSafeAreaInsets();

  const state = levelBarState(container);
  const low = state === 'low';

  const handleRefillFull = () => {
    if (busy) return;
    setConfirmRefill(false);
    onRefillFull();
  };

  const handleRefillPartial = () => {
    if (busy) return;
    const addedMl = parseFloat(partialInput);
    if (Number.isNaN(addedMl) || addedMl <= 0) {
      setPartialError('Enter a positive volume');
      return;
    }
    setPartialError('');
    // Additive refill: the entered volume is added to the current level,
    // clamped at capacity.
    onRefillPartial(
      additiveRefillTarget(container.currentMl, container.capacityMl, addedMl),
    );
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
          {/*
           * The ScrollView must stay BOUNDED (flex:1) inside the maxHeight'd
           * sheetContent — an unbounded ScrollView sizes to its content and
           * overflows the sheet instead of scrolling, which is what half-
           * clipped the bottom button. The header/handle above are fixed so
           * the close control is reachable no matter the content height.
           */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingBottom: insets.bottom + T.spacing.xxl,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
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
                    accessibilityRole="button"
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
                    accessibilityRole="button"
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
                accessibilityRole="button"
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
            <ThemedTextInput
              style={styles.modalInput}
              keyboardType="decimal-pad"
              placeholder="Volume (mL)"
              placeholderTextColor={T.colors.textMuted}
              value={partialInput}
              onChangeText={setPartialInput}
            />
            <ThemedText style={styles.sheetHelperText}>
              Adds to current level, up to capacity
            </ThemedText>
            <Pressable
              style={[
                styles.modalButton,
                styles.confirmButton,
                busy && styles.confirmButtonDisabled,
              ]}
              disabled={busy}
              accessibilityRole="button"
              onPress={handleRefillPartial}>
              <ThemedText style={styles.confirmButtonText}>
                Refill partial
              </ThemedText>
            </Pressable>
            {partialError ? (
              <ThemedText style={styles.modalError}>{partialError}</ThemedText>
            ) : null}

            <ThemedText style={styles.sheetSectionLabel}>ADJUST LEVEL</ThemedText>
            <ThemedTextInput
              style={styles.modalInput}
              keyboardType="decimal-pad"
              placeholder="Current level (mL)"
              placeholderTextColor={T.colors.textMuted}
              value={adjustInput}
              onChangeText={setAdjustInput}
            />
            <ThemedText style={styles.sheetHelperText}>
              Overrides the current level exactly
            </ThemedText>
            <Pressable
              style={[
                styles.modalButton,
                styles.confirmButton,
                busy && styles.confirmButtonDisabled,
              ]}
              disabled={busy}
              accessibilityRole="button"
              onPress={handleAdjust}>
              <ThemedText style={styles.confirmButtonText}>Set level</ThemedText>
            </Pressable>
            {adjustError ? (
              <ThemedText style={styles.modalError}>{adjustError}</ThemedText>
            ) : null}

            {editing ? (
              <View>
                <ThemedText style={styles.sheetSectionLabel}>
                  EDIT RESERVOIR
                </ThemedText>
                <ThemedText style={styles.sheetFieldLabel}>
                  Reservoir name
                </ThemedText>
                <ThemedTextInput
                  style={styles.modalInput}
                  placeholder="Name"
                  placeholderTextColor={T.colors.textMuted}
                  value={nameInput}
                  onChangeText={setNameInput}
                  accessibilityLabel="Reservoir name"
                />
                <ThemedText style={styles.sheetFieldLabel}>
                  Capacity (mL)
                </ThemedText>
                <ThemedTextInput
                  style={styles.modalInput}
                  keyboardType="decimal-pad"
                  placeholder="Capacity (mL)"
                  placeholderTextColor={T.colors.textMuted}
                  value={capacityInput}
                  onChangeText={setCapacityInput}
                  accessibilityLabel="Capacity (mL)"
                />
                <ThemedText style={styles.sheetFieldLabel}>
                  Low alert threshold (mL)
                </ThemedText>
                <ThemedTextInput
                  style={styles.modalInput}
                  keyboardType="decimal-pad"
                  placeholder="Low threshold (mL)"
                  placeholderTextColor={T.colors.textMuted}
                  value={thresholdInput}
                  onChangeText={setThresholdInput}
                  accessibilityLabel="Low alert threshold (mL)"
                />
                <ThemedText style={styles.sheetHelperText}>
                  Banner alerts when level drops to this
                </ThemedText>
                {editError ? (
                  <ThemedText style={styles.modalError}>{editError}</ThemedText>
                ) : null}
                <View style={styles.modalButtons}>
                  <Pressable
                    style={[styles.modalButton, styles.cancelButton]}
                    disabled={busy}
                    accessibilityRole="button"
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
                    accessibilityRole="button"
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
                accessibilityRole="button"
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

const styles = StyleSheet.create({
  modalError: {
    ...T.typography.small,
    color: T.colors.danger,
    marginBottom: T.spacing.md,
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
    // Icon + label buttons ("Edit details") must lay out on ONE line inside
    // the button: the base modalButton has no flexDirection, so children
    // stacked vertically and overflowed the fixed height. Matches the
    // confirmButton row layout.
    flexDirection: 'row',
    gap: T.spacing.sm,
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
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonTextDisabled: {
    fontFamily: T.typography.fontFamily.regular,
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
    // No bottom padding here: scroll-end clearance lives on the ScrollView's
    // contentContainer (safe-area inset + spacing) so the last element is
    // never flush against the sheet edge, scrolled or not.
    paddingBottom: 0,
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
  sheetFieldLabel: {
    ...T.typography.caption,
    color: T.colors.textMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: T.spacing.md,
    marginBottom: T.spacing.xs,
  },
  sheetHelperText: {
    ...T.typography.small,
    color: T.colors.textMuted,
    marginBottom: T.spacing.md,
  },
});
