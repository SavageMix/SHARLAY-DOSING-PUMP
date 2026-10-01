/**
 * Missed-dose decision logic — pure functions so the modal's safety
 * invariants are directly testable without a component harness.
 *
 * HARD RULES encoded here:
 * 1. Submission happens only via an explicit button press. Ticking a
 *    checkbox produces selection state only — no plan, no request.
 * 2. Omission never dismisses. "Dose selected" confirms ONLY the ticked
 *    entries; unticked entries stay pending. Dismissal exists solely in the
 *    explicit Skip paths (per-dose and per-pump).
 * 3. While the decision modal is open, background polling must not mutate
 *    the in-progress list or close the modal.
 */

export interface DoseSelectionPlan {
  /** Entries to fire — exactly the ticked ones, nothing else. */
  selectedIds: string[];
  /**
   * ALWAYS empty. Unticked entries stay pending; they are never dismissed
   * as a side effect of confirming others. The field exists so call sites
   * structurally cannot reintroduce dismiss-on-omit: the confirm handler
   * only ever reads `selectedIds`.
   */
  dismissIds: string[];
}

export function toggleChecked(
  checked: Record<string, boolean>,
  id: string,
  value: boolean,
): Record<string, boolean> {
  return { ...checked, [id]: value };
}

/**
 * Build the plan for an explicit "Dose selected (N)" press. Pure: selection
 * state in, plan out. No side effects, no implicit dismissal.
 */
export function planDoseSelection<T extends { id: string }>(
  entries: T[],
  checked: Record<string, boolean>,
): DoseSelectionPlan {
  return {
    selectedIds: entries.filter((e) => checked[e.id]).map((e) => e.id),
    dismissIds: [],
  };
}

/**
 * Decide which pending entries the decision list shows after a poll.
 *
 * Two rules:
 * - FREEZE while a list is on screen (an open review, or a non-empty current
 *   list): background polls must never mutate or re-render an in-progress
 *   decision — a layout-shift mis-tap submitted a batch on hardware once.
 * - Otherwise take the fresh pending list WHOLE. The Catch-ups page is the
 *   always-available decision UI: snoozed ("Decide later") entries stay
 *   listed and actionable on every visit, so the pending count and the
 *   decisions shown always come from the same payload — a count can never
 *   show entries the page can't display.
 */
export function nextModalList<T>(
  reviewOpen: boolean,
  currentList: T[],
  freshPending: T[],
): T[] {
  if (reviewOpen || currentList.length > 0) return currentList;
  return freshPending;
}
