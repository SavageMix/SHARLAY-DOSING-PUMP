import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IntegrityFinding } from '@reef/shared';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

import {
  activeFindings,
  loadDismissedFindingIds,
  saveDismissedFindingIds,
} from './integrity-findings';

function finding(id: string): IntegrityFinding {
  return { id, check: 'orphan-catchup-event', message: `finding ${id}` };
}

describe('integrity findings', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('activeFindings filters dismissed ids and keeps the rest in order', () => {
    const findings = [finding('a'), finding('b'), finding('c')];
    expect(activeFindings(findings, new Set(['b']))).toEqual([finding('a'), finding('c')]);
    expect(activeFindings(findings, new Set())).toHaveLength(3);
    expect(activeFindings(findings, new Set(['a', 'b', 'c']))).toEqual([]);
  });

  it('dismissed ids round-trip through storage', async () => {
    expect((await loadDismissedFindingIds()).size).toBe(0);
    await saveDismissedFindingIds(new Set(['x', 'y']));
    expect([...(await loadDismissedFindingIds())].sort()).toEqual(['x', 'y']);
  });

  it('unreadable storage yields an empty set — show everything, hide nothing', async () => {
    storage.set('reef.dismissedIntegrityFindings', '{not json');
    expect((await loadDismissedFindingIds()).size).toBe(0);
  });
});
