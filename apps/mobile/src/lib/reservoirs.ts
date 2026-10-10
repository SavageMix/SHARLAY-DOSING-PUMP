import type { ContainerStatus } from '@reef/shared';

/**
 * Reservoir level display logic (Dashboard Reservoirs card + low banner).
 *
 * The device owns all level truth: current_ml is decremented when doses
 * finalize and only a refill/adjust/server edit moves it. These helpers are
 * pure formatters/derivations over GET /api/containers's ContainerStatus —
 * never over local UI state — so a refresh mid-edit re-renders exactly the
 * same levels.
 */

export type LevelBarState = 'low' | 'warning' | 'ok';

/** Fraction of capacity below which a non-low reservoir still shows amber. */
const WARNING_FRACTION = 0.25;

export function levelBarState(container: ContainerStatus): LevelBarState {
  if (container.currentMl <= container.lowThresholdMl) return 'low';
  if (
    container.capacityMl > 0 &&
    container.currentMl < container.capacityMl * WARNING_FRACTION
  ) {
    return 'warning';
  }
  return 'ok';
}

/** "742 / 1000 mL" — integers, no decimals. */
export function formatLevel(container: ContainerStatus): string {
  return `${Math.round(container.currentMl)} / ${Math.round(container.capacityMl)} mL`;
}

export function formatDaysRemaining(daysRemaining: number | null): string {
  if (daysRemaining === null) return 'no usage yet';
  if (daysRemaining < 1) return '< 1 day left';
  const days = Math.floor(daysRemaining);
  return `≈ ${days} ${days === 1 ? 'day' : 'days'} left`;
}

/** The low reservoirs, emptiest first — what the dashboard banner lists. */
export function lowReservoirs(containers: ContainerStatus[]): ContainerStatus[] {
  return containers
    .filter((c) => c.low)
    .slice()
    .sort((a, b) => a.currentMl - b.currentMl);
}

/** "ALK reservoir low — 86 mL left" (display name uppercased). */
export function lowBannerText(container: ContainerStatus): string {
  return `${container.name.toUpperCase()} reservoir low — ${Math.round(
    container.currentMl,
  )} mL left`;
}
