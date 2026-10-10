import { describe, expect, it } from 'vitest';
import type { ContainerStatus } from '@reef/shared';
import {
  formatDaysRemaining,
  formatLevel,
  levelBarState,
  lowBannerText,
  lowReservoirs,
} from './reservoirs';

function container(
  partial: Partial<ContainerStatus> & { pumpId: ContainerStatus['pumpId'] },
): ContainerStatus {
  return {
    name: partial.pumpId.toUpperCase(),
    capacityMl: 1000,
    currentMl: 500,
    lowThresholdMl: 100,
    updatedAt: '2026-08-23T18:00:00.000Z',
    daysRemaining: 10,
    low: false,
    ...partial,
  };
}

describe('levelBarState', () => {
  it('is low at the threshold (inclusive)', () => {
    expect(
      levelBarState(container({ pumpId: 'alk', currentMl: 100, lowThresholdMl: 100 })),
    ).toBe('low');
  });

  it('is low below the threshold', () => {
    expect(
      levelBarState(container({ pumpId: 'alk', currentMl: 86, lowThresholdMl: 100 })),
    ).toBe('low');
  });

  it('is low at zero', () => {
    expect(
      levelBarState(container({ pumpId: 'po4', currentMl: 0, lowThresholdMl: 0 })),
    ).toBe('low');
  });

  it('is warning above the threshold but under 25% of capacity', () => {
    expect(
      levelBarState(container({ pumpId: 'ca', currentMl: 249, lowThresholdMl: 100 })),
    ).toBe('warning');
  });

  it('is ok at exactly 25% of capacity (warning is strictly below)', () => {
    expect(
      levelBarState(container({ pumpId: 'ca', currentMl: 250, lowThresholdMl: 100 })),
    ).toBe('ok');
  });

  it('is ok near full', () => {
    expect(
      levelBarState(container({ pumpId: 'no3', currentMl: 742, lowThresholdMl: 100 })),
    ).toBe('ok');
  });

  it('low wins over warning when the threshold is above 25% of capacity', () => {
    expect(
      levelBarState(
        container({ pumpId: 'alk', capacityMl: 1000, currentMl: 400, lowThresholdMl: 500 }),
      ),
    ).toBe('low');
  });

  it('does not divide by zero when capacity is 0', () => {
    expect(
      levelBarState(container({ pumpId: 'alk', capacityMl: 0, currentMl: 0, lowThresholdMl: -1 })),
    ).toBe('ok');
  });
});

describe('formatLevel', () => {
  it('formats integers without decimals', () => {
    expect(
      formatLevel(container({ pumpId: 'alk', currentMl: 742, capacityMl: 1000 })),
    ).toBe('742 / 1000 mL');
  });

  it('rounds fractional levels', () => {
    expect(
      formatLevel(container({ pumpId: 'ca', currentMl: 86.4, capacityMl: 999.6 })),
    ).toBe('86 / 1000 mL');
  });

  it('handles an empty reservoir', () => {
    expect(
      formatLevel(container({ pumpId: 'po4', currentMl: 0, capacityMl: 500 })),
    ).toBe('0 / 500 mL');
  });
});

describe('formatDaysRemaining', () => {
  it('is honest when there is no usage data', () => {
    expect(formatDaysRemaining(null)).toBe('no usage yet');
  });

  it('formats many days', () => {
    expect(formatDaysRemaining(23)).toBe('≈ 23 days left');
  });

  it('uses a singular day for exactly 1', () => {
    expect(formatDaysRemaining(1)).toBe('≈ 1 day left');
  });

  it('floors fractional days', () => {
    expect(formatDaysRemaining(23.9)).toBe('≈ 23 days left');
  });

  it('shows sub-day levels as under one day', () => {
    expect(formatDaysRemaining(0.9)).toBe('< 1 day left');
  });

  it('shows zero as under one day', () => {
    expect(formatDaysRemaining(0)).toBe('< 1 day left');
  });

  it('clamps negative estimates to under one day', () => {
    expect(formatDaysRemaining(-2)).toBe('< 1 day left');
  });
});

describe('lowReservoirs', () => {
  it('returns only the low containers, emptiest first', () => {
    const alk = container({ pumpId: 'alk', currentMl: 120, low: true });
    const ca = container({ pumpId: 'ca', currentMl: 30, low: true });
    const no3 = container({ pumpId: 'no3', currentMl: 900, low: false });
    const po4 = container({ pumpId: 'po4', currentMl: 5, low: true });
    expect(lowReservoirs([alk, ca, no3, po4])).toEqual([po4, ca, alk]);
  });

  it('returns an empty array when nothing is low', () => {
    expect(
      lowReservoirs([
        container({ pumpId: 'alk', currentMl: 900 }),
        container({ pumpId: 'ca', currentMl: 400 }),
      ]),
    ).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [
      container({ pumpId: 'alk', currentMl: 200, low: true }),
      container({ pumpId: 'ca', currentMl: 100, low: true }),
    ];
    const snapshot = [...input];
    lowReservoirs(input);
    expect(input).toEqual(snapshot);
  });
});

describe('lowBannerText', () => {
  it('uppercases the name and reports the remaining mL', () => {
    expect(
      lowBannerText(
        container({ pumpId: 'alk', name: 'Alkalinity', currentMl: 86 }),
      ),
    ).toBe('ALKALINITY reservoir low — 86 mL left');
  });

  it('keeps an already-uppercase name unchanged', () => {
    expect(
      lowBannerText(container({ pumpId: 'alk', name: 'ALK', currentMl: 86 })),
    ).toBe('ALK reservoir low — 86 mL left');
  });

  it('rounds fractional remaining volume', () => {
    expect(
      lowBannerText(container({ pumpId: 'po4', name: 'PO4', currentMl: 4.6 })),
    ).toBe('PO4 reservoir low — 5 mL left');
  });
});
