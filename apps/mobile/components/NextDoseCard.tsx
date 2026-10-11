import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ThemedText } from '@/components/ThemedText';
import { Theme } from '@/constants/Theme';
import { formatDateTime, formatDuration } from '@/src/lib/format';
import { nextDoseDetails, nextDoseSourceTag, type NextDose } from '@/src/lib/next-dose';
import { PUMP_COLORS, PUMP_DISPLAY_NAMES } from '@/src/lib/pumps';

const T = Theme;

/** 1s clock shared by the dashboard card and the detail sheet. */
export function useNowTicker(): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Dashboard next-dose card. Shrink-proofing contract: the right block
 * (countdown + fire time + chevron) is flexShrink: 0 and its texts are
 * single-line, so it can never compress or slide under the "Dose now"
 * button; the left block is flex: 1 and truncates (middle-ellipsis on the
 * pump name and volume) instead of overflowing.
 */
export function NextDoseCard({
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
          <View style={styles.nextDoseBody}>
            <ThemedText style={styles.nextDoseOverline}>NEXT DOSE</ThemedText>
            <ThemedText
              style={styles.nextDosePump}
              numberOfLines={1}
              ellipsizeMode="middle">
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
        <View style={styles.nextDoseBody}>
          <ThemedText style={styles.nextDoseOverline}>NEXT DOSE</ThemedText>
          <View style={styles.nextDoseRow}>
            <ThemedText
              style={[
                styles.nextDosePump,
                { color: PUMP_COLORS[details.pumpId] },
              ]}
              numberOfLines={1}
              ellipsizeMode="middle">
              {PUMP_DISPLAY_NAMES[details.pumpId]}
            </ThemedText>
            <View style={styles.sourceTag}>
              <ThemedText style={styles.sourceTagText}>
                {nextDoseSourceTag(nextDose)}
              </ThemedText>
            </View>
            <ThemedText
              style={styles.nextDoseVolume}
              numberOfLines={1}
              ellipsizeMode="middle">
              {details.volumeMl.toFixed(1)} mL
            </ThemedText>
          </View>
        </View>
      </View>
      <View style={styles.nextDoseRight}>
        <ThemedText style={styles.nextDoseCountdown} numberOfLines={1}>
          {countdown}
        </ThemedText>
        <ThemedText style={styles.nextDoseTime} numberOfLines={1}>
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

const glassBase: ViewStyle = {
  backgroundColor: 'rgba(17, 24, 39, 0.72)',
  borderRadius: T.radius.lg,
  borderWidth: 1,
  borderColor: T.colors.border,
  padding: T.spacing.lg,
  marginBottom: T.spacing.lg,
};

const styles = StyleSheet.create({
  nextDoseCard: {
    ...glassBase,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: T.spacing.md,
    marginBottom: 0,
  },
  // Absorbs all compression so the right block stays intact.
  nextDoseLeft: {
    flex: 1,
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
  // Overline + name/tag/volume column; flex:1 lets the row truncate.
  nextDoseBody: {
    flex: 1,
  },
  nextDoseOverline: {
    ...T.typography.caption,
    color: T.colors.textMuted,
    marginBottom: 2,
  },
  // flexShrink: 1 so the pump name/volume texts can shrink inside it.
  nextDoseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    flexShrink: 1,
  },
  nextDosePump: {
    ...T.typography.title,
    color: T.colors.textPrimary,
    flexShrink: 1,
  },
  nextDoseVolume: {
    ...T.typography.body,
    color: T.colors.accent,
    fontFamily: T.typography.fontFamily.medium,
    flexShrink: 1,
  },
  // Countdown + fire time + chevron: NEVER compresses or slides.
  nextDoseRight: {
    alignItems: 'flex-end',
    gap: 2,
    flexShrink: 0,
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
  sourceTag: {
    backgroundColor: 'rgba(32, 227, 219, 0.12)',
    borderRadius: T.radius.pill,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 2,
  },
  sourceTagText: {
    ...T.typography.caption,
    color: T.colors.primary,
    fontFamily: T.typography.fontFamily.semiBold,
    letterSpacing: 0.5,
  },
});
