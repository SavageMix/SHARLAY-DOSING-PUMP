import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IntegrityFinding } from '@reef/shared';

/**
 * Boot-time integrity audit findings (see apps/device/src/audit.ts). The
 * device detects disagreements in the dosing record and reports them here;
 * it never repairs anything, so dismissal is purely a display concern — the
 * finding IDs the user has read are remembered locally and never touch the
 * underlying records on the device.
 */

const DISMISSED_KEY = 'reef.dismissedIntegrityFindings';

/** Findings not yet dismissed by the user — what banners and lists render. */
export function activeFindings(
  findings: IntegrityFinding[],
  dismissedIds: ReadonlySet<string>,
): IntegrityFinding[] {
  return findings.filter((f) => !dismissedIds.has(f.id));
}

export async function loadDismissedFindingIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    // Storage unreadable (or mock absent): show everything rather than hide it.
    return new Set();
  }
}

export async function saveDismissedFindingIds(
  dismissedIds: ReadonlySet<string>,
): Promise<void> {
  await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedIds]));
}
