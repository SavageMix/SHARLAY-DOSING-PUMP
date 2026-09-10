import type { CatchupQueueItem, PumpId } from '@reef/shared';

const PUMP_SHORT: Record<PumpId, string> = {
  alk: 'ALK',
  ca: 'CA',
  no3: 'NO3',
  po4: 'PO4',
};

export interface CatchupBannerModel {
  visible: boolean;
  text: string;
}

export interface CatchupBannerFormatters {
  /** Original missed slot, e.g. "Today 06:00". */
  formatSlot: (iso: string) => string;
  /** Estimated fire time, e.g. "19:52". */
  formatTime: (iso: string) => string;
}

function defaultTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function describeItem(item: CatchupQueueItem, format: CatchupBannerFormatters): string {
  const when = item.missedDoseScheduledFor
    ? format.formatSlot(item.missedDoseScheduledFor)
    : '—';
  return `missed ${when} (${PUMP_SHORT[item.pumpId]})`;
}

/**
 * Pure text builder for the Dashboard catch-up banner. 100% derived from
 * /api/status's catchupQueue — never from local UI state — so a page refresh
 * mid-dose or mid-queue re-renders exactly the same banner.
 *
 * - Firing only:  "Firing catch-up — missed 19:20 (ALK)"
 * - Queued too:   "… · 3 queued: PO4 ~19:52, NO3 ~19:53, CA ~19:55"
 * - Queued only:  "Catch-ups queued: PO4 ~19:52, …"
 */
export function describeCatchupQueue(
  firing: CatchupQueueItem | null,
  queued: CatchupQueueItem[],
  format: Partial<CatchupBannerFormatters> = {},
): CatchupBannerModel {
  const fmt: CatchupBannerFormatters = {
    formatSlot: (iso) => iso,
    formatTime: defaultTime,
    ...format,
  };
  if (!firing && queued.length === 0) return { visible: false, text: '' };

  const queuedList = queued
    .map((q) => `${PUMP_SHORT[q.pumpId]} ~${fmt.formatTime(q.estimatedFireAt ?? '')}`)
    .join(', ');

  if (firing && queued.length > 0) {
    return {
      visible: true,
      text:
        `Firing catch-up — ${describeItem(firing, fmt)} · ` +
        `${queued.length} queued: ${queuedList}`,
    };
  }
  if (firing) {
    return {
      visible: true,
      text: `Firing catch-up — ${describeItem(firing, fmt)}`,
    };
  }
  return {
    visible: true,
    text: `Catch-ups queued: ${queuedList}`,
  };
}
