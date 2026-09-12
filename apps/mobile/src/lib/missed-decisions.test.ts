import { describe, expect, it } from 'vitest';
import {
  nextModalList,
  planDoseSelection,
  toggleChecked,
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

  describe('nextModalList — polling never mutates an open modal', () => {
    const fresh = [
      { id: 'a', deferredUntil: null },
      { id: 'b', deferredUntil: '2999-01-01T00:00:00.000Z' },
    ];

    it('returns the current list untouched while entries are visible', () => {
      const current = [{ id: 'user-is-deciding', deferredUntil: null }];
      expect(nextModalList(false, current, fresh, Date.now())).toBe(current);
    });

    it('returns the current list untouched while a review is open', () => {
      const current: Array<{ id: string; deferredUntil?: string | null }> = [];
      expect(nextModalList(true, current, fresh, Date.now())).toBe(current);
    });

    it('takes the fresh pending list only when the modal is closed', () => {
      expect(nextModalList(false, [], fresh, Date.now())).toEqual([
        { id: 'a', deferredUntil: null },
      ]);
    });

    it('re-shows snoozed entries whose snooze has lapsed', () => {
      const lapsed = [
        { id: 'a', deferredUntil: null },
        { id: 'b', deferredUntil: '2000-01-01T00:00:00.000Z' },
      ];
      const next = nextModalList(false, [], lapsed, Date.now());
      expect(next.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });
});
