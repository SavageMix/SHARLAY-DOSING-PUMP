import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ThemedText } from '@/components/ThemedText';
import { Theme } from '@/constants/Theme';

const T = Theme;

export function OfflineCard({ onRetry }: { onRetry?: () => void }) {
  return (
    <Pressable onPress={onRetry} style={styles.card} disabled={!onRetry}>
      <View style={styles.row}>
        <View style={styles.left}>
          <View style={styles.statusRow}>
            <View style={styles.dot} />
            <ThemedText style={styles.overline}>SYSTEM STATUS</ThemedText>
          </View>
          <ThemedText style={styles.title}>Device Offline</ThemedText>
          <ThemedText style={styles.sub}>
            {onRetry ? 'Tap to retry connection.' : 'Check your network.'}
          </ThemedText>
        </View>
        <View style={[styles.ring, { borderColor: T.colors.danger }]}>
          <Ionicons name="alert" size={28} color={T.colors.danger} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(17, 24, 39, 0.72)',
    borderRadius: T.radius.lg,
    borderWidth: 1,
    borderColor: T.colors.border,
    padding: T.spacing.lg,
    marginBottom: T.spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flex: 1,
    paddingRight: T.spacing.md,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    marginBottom: T.spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: T.colors.danger,
  },
  overline: {
    ...T.typography.caption,
    color: T.colors.textMuted,
  },
  title: {
    ...T.typography.h3,
    color: T.colors.textPrimary,
    marginBottom: 2,
  },
  sub: {
    ...T.typography.small,
    color: T.colors.textSecondary,
  },
  ring: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
