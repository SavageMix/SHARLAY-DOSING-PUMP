import { describe, expect, it } from 'vitest';
import {
  nextModalList,
  planDoseSelection,
  sectionSelection,
  toggleChecked,
  toggleSelectAll,
} from './missed-decisions';

const entries = Array.from({ length: 8 }, (_, i) => ({ id: `md-${i}` }));

describe('missed-dose decisions', () => {
  it('ticking every checkbox produces selection state only — no dismiss, no submit plan', () => {
    let checked: Record<string, boolean> = {};
    // Simulate the reported repro: tick all 8 checkboxes, one by one.
    for (const e of entries) {
      checked = toggleChecked(checked, e.id, true);
    }
    const plan = planDoseSelection(entries, checked);
    expect(plan.selectedIds).toEqual(entries.map((e) => e.id));
    // The regression: unselected must NEVER be dismissed by omission.
    expect(plan.dismissIds).toEqual([]);
  });

  it('partial selection confirms only the ticked entries; unticked stay pending', () => {
    const checked: Record<string, boolean> = {
      'md-0': true,
      'md-1': true,
      'md-2': true,
      'md-3': true,
      'md-4': true,
      'md-5': true,
      // md-6, md-7 deliberately unticked — user wants to defer them.
    };
    const plan = planDoseSelection(entries, checked);
    expect(plan.selectedIds).toHaveLength(6);
    expect(plan.selectedIds).not.toContain('md-6');
    expect(plan.selectedIds).not.toContain('md-7');
    // Nothing is destroyed by omission.
    expect(plan.dismissIds).toEqual([]);
  });

  it('planDoseSelection is pure — ticking alone never fires anything', () => {
    const checked = toggleChecked({}, 'md-0', true);
    const before = JSON.stringify(checked);
    planDoseSelection(entries, checked);
    expect(JSON.stringify(checked)).toBe(before);
  });

  it('untoggling removes the entry from the plan', () => {
    let checked = toggleChecked({}, 'md-0', true);
    checked = toggleChecked(checked, 'md-0', false);
    expect(planDoseSelection(entries, checked).selectedIds).toEqual([]);
  });

  describe('select all — tri-state toggle, selection state only', () => {
    const ids = entries.map((e) => e.id);

    it('sectionSelection reports none / some / all', () => {
      expect(sectionSelection(ids, {})).toBe('none');
      expect(sectionSelection(ids, { 'md-0': true, 'md-1': true })).toBe('some');
      const all: Record<string, boolean> = {};
      for (const id of ids) all[id] = true;
      expect(sectionSelection(ids, all)).toBe('all');
      // Empty section is 'none', never 'all'.
      expect(sectionSelection([], all)).toBe('none');
    });

    it('toggleSelectAll from none ticks every id in the section', () => {
      const next = toggleSelectAll(ids, {});
      expect(sectionSelection(ids, next)).toBe('all');
      expect(planDoseSelection(entries, next).selectedIds).toEqual(ids);
    });

    it('toggleSelectAll from all clears the section', () => {
      const all: Record<string, boolean> = {};
      for (const id of ids) all[id] = true;
      const next = toggleSelectAll(ids, all);
      expect(sectionSelection(ids, next)).toBe('none');
      expect(planDoseSelection(entries, next).selectedIds).toEqual([]);
    });

    it('toggleSelectAll from partial toggles TO all (not to none)', () => {
      const next = toggleSelectAll(ids, { 'md-0': true, 'md-1': true });
      expect(sectionSelection(ids, next)).toBe('all');
    });

    it('toggling selects only that section — other pumps untouched', () => {
      const checked = { 'other-pump-1': true };
      const next = toggleSelectAll(ids, checked);
      // The other pump's selection is preserved…
      expect(next['other-pump-1']).toBe(true);
      // …and this section is fully ticked.
      expect(sectionSelection(ids, next)).toBe('all');
    });

    it('toggling alone never submits or dismisses — pure selection state', () => {
      const before = JSON.stringify({});
      const next = toggleSelectAll(ids, {});
      expect(JSON.stringify(next)).not.toBe(before);
      // The only plan derivable is "what a later explicit button press fires".
      expect(planDoseSelection(entries, next).dismissIds).toEqual([]);
    });
  });

  describe('nextModalList — polling never mutates an open decision', () => {
    const fresh = [
      { id: 'a', deferredUntil: null },
      { id: 'b', deferredUntil: '2999-01-01T00:00:00.000Z' },
    ];

    it('returns the current list untouched while entries are visible', () => {
      const current = [{ id: 'user-is-deciding', deferredUntil: null }];
      expect(nextModalList(false, current, fresh)).toBe(current);
    });

    it('returns the current list untouched while a review is open', () => {
      const current: Array<{ id: string; deferredUntil?: string | null }> = [];
      expect(nextModalList(true, current, fresh)).toBe(current);
    });

    it('takes the fresh pending list whole when the list is empty — snoozed entries are decisions too', () => {
      // The Catch-ups page is the always-available decision UI: entries
      // snoozed via "Decide later" stay listed and actionable on every
      // visit, so the pending count and the decisions shown come from the
      // same payload and can never disagree.
      expect(nextModalList(false, [], fresh)).toEqual(fresh);
    });
  });
});
