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
 * Decide whether a background poll may refresh the modal's entry list.
 * Only when the modal is fully closed (no open review, no visible entries)
 * does the poll take over — the user's in-progress selection is sacred.
 */
export function nextModalList<T extends { deferredUntil?: string | null }>(
  reviewOpen: boolean,
  currentList: T[],
  freshPending: T[],
  now: number,
): T[] {
  if (reviewOpen || currentList.length > 0) return currentList;
  return freshPending.filter(
    (m) =>
      !m.deferredUntil ||
      Number.isNaN(new Date(m.deferredUntil).getTime()) ||
      new Date(m.deferredUntil).getTime() <= now,
  );
}
