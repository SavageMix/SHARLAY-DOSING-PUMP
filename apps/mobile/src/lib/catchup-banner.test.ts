import { describe, expect, it } from 'vitest';
import type { CatchupQueueItem } from '@reef/shared';
import { describeCatchupQueue } from './catchup-banner';

const fmt = {
  formatSlot: (iso: string) => `slot(${iso})`,
  formatTime: (iso: string) => `t(${iso})`,
};

function item(partial: Partial<CatchupQueueItem> & { pumpId: CatchupQueueItem['pumpId'] }): CatchupQueueItem {
  return {
    missedDoseId: `md-${partial.pumpId}`,
    missedDoseScheduledFor: '2026-08-23T18:00:00.000Z',
    estimatedFireAt: '2026-08-24T19:52:00.000Z',
    ...partial,
  };
}

describe('describeCatchupQueue', () => {
  it('is hidden when nothing is firing or queued', () => {
    expect(describeCatchupQueue(null, [], fmt)).toEqual({
      visible: false,
      text: '',
    });
  });

  it('describes a firing catch-up with its missed slot and pump', () => {
    const result = describeCatchupQueue(item({ pumpId: 'alk' }), [], fmt);
    expect(result.visible).toBe(true);
    expect(result.text).toBe(
      'Firing catch-up — missed slot(2026-08-23T18:00:00.000Z) (ALK)',
    );
  });

  it('appends the queued list with estimated fire times', () => {
    const result = describeCatchupQueue(
      item({ pumpId: 'alk' }),
      [
        item({ pumpId: 'po4', estimatedFireAt: '19:52' }),
        item({ pumpId: 'no3', estimatedFireAt: '19:53' }),
        item({ pumpId: 'ca', estimatedFireAt: '19:55' }),
      ],
      fmt,
    );
    expect(result.text).toBe(
      'Firing catch-up — missed slot(2026-08-23T18:00:00.000Z) (ALK) · ' +
        '3 queued: PO4 ~t(19:52), NO3 ~t(19:53), CA ~t(19:55)',
    );
  });

  it('shows a single queued catch-up without a firing entry', () => {
    const result = describeCatchupQueue(null, [item({ pumpId: 'po4', estimatedFireAt: '19:52' })], fmt);
    expect(result.text).toBe('Catch-ups queued: PO4 ~t(19:52)');
  });

  it('renders "—" for a missing missed-slot time', () => {
    const result = describeCatchupQueue(
      item({ pumpId: 'alk', missedDoseScheduledFor: null }),
      [],
      fmt,
    );
    expect(result.text).toBe('Firing catch-up — missed — (ALK)');
  });

  it('falls back to a default HH:MM time formatter', () => {
    const result = describeCatchupQueue(null, [
      item({ pumpId: 'po4', estimatedFireAt: '2026-08-24T19:52:00.000Z' }),
    ]);
    expect(result.visible).toBe(true);
    // Exact rendering is locale-dependent; the pump and tilde must be there.
    expect(result.text).toMatch(/^Catch-ups queued: PO4 ~\d{1,2}:\d{2}$/);
  });
});
