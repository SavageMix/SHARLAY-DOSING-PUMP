import type { DoseEvent, DoseQueueItem, DoseSource, PumpId } from '@reef/shared';

/**
 * Dashboard dose-queue panel (ConnectedDeviceCard expanded view).
 *
 * Pure reshaping of /api/status's currentDose + queueItems — the same
 * reconcile-not-transition contract as lib/dose-states: the device owns
 * queue truth, this only lays it out. Queue positions are 1-based from the
 * front; a firing dose is position 0 and is never cancellable here (it can
 * no longer be withdrawn). Only manual rows are cancellable — catch-ups stay
 * cancellable from the Catch-ups page, where their missed-dose context lives.
 */

export interface QueuePanelItem {
  /** 0 = firing now, 1..n = FIFO position. */
  position: number;
  pumpId: PumpId;
  amountMl: number;
  sourceLabel: string;
  /** Wall-clock estimate (device-local at render time), '~'-prefixed by the UI. */
  estimatedFireAt: string;
  /** The job id a cancel request references. */
  jobId: string;
  canCancel: boolean;
  isCurrent: boolean;
}

export function sourceLabel(source: DoseSource): string {
  return source === 'catchup' ? 'catch-up' : source;
}

export function buildQueuePanel(
  current: DoseEvent | null,
  queueItems: DoseQueueItem[],
): QueuePanelItem[] {
  const rows: QueuePanelItem[] = [];
  if (current) {
    rows.push({
      position: 0,
      pumpId: current.pumpId,
      amountMl: current.requestedMl,
      sourceLabel: sourceLabel(current.source),
      estimatedFireAt: current.startedAt,
      jobId: current.id,
      canCancel: false,
      isCurrent: true,
    });
  }
  queueItems.forEach((item, index) => {
    rows.push({
      position: index + 1,
      pumpId: item.pumpId,
      amountMl: item.amountMl,
      sourceLabel: sourceLabel(item.source),
      estimatedFireAt: item.estimatedFireAt,
      jobId: item.id,
      canCancel: item.source === 'manual',
      isCurrent: false,
    });
  });
  return rows;
}
