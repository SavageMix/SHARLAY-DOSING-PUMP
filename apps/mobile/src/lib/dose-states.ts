import type { DoseEvent } from '@reef/shared';

/**
 * Manual-dose tracking (Dashboard dose banners).
 *
 * The device owns all dosing truth: POST /api/dose only acknowledges the
 * job (202 + jobId), and the verdict — completed, or rejected by the daily
 * cap / calibration check — lands later in the dose record. The app must
 * therefore never promote a dose to 'done' on its own. When a tracked event
 * leaves the live queue, only history knows the outcome; until history
 * confirms it, the state stays as-is and the next poll decides.
 *
 * In-progress indicators (queued/running) and outcomes alike derive from
 * /api/status + /api/history on every poll — never from a local tap-time
 * flag — so the app and the engine cannot disagree.
 */

export type DoseTrackingStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'done'
  | 'error';

export interface DoseTrackingState {
  status: DoseTrackingStatus;
  message: string;
  eventId?: string;
}

/** Per-pump tracking map; only pumps with something to say have an entry. */
export type DoseStates = Record<string, DoseTrackingState>;

export interface ReconcileDoseStatesInput {
  currentDose: DoseEvent | null;
  queue: DoseEvent[];
  /** Recent dose events (e.g. GET /api/history) — the only source of verdicts. */
  history: DoseEvent[];
}

function outcomeState(
  event: DoseEvent,
  eventId: string,
): DoseTrackingState {
  if (event.status === 'completed') {
    return { status: 'done', message: 'Dose finished', eventId };
  }
  // failed / interrupted / rejected: surface the server's own reason (e.g.
  // the daily-cap message) — never a green 'finished' for a dose that did
  // not happen.
  return {
    status: 'error',
    message: event.error ?? `Dose ${event.status}`,
    eventId,
  };
}

/**
 * Fold a device report into the per-pump tracking states. Pure: returns a
 * new record, leaves `prev` untouched, and only mutates entries the report
 * actually speaks about.
 */
export function reconcileDoseStates(
  prev: DoseStates,
  input: ReconcileDoseStatesInput,
): DoseStates {
  const next: DoseStates = { ...prev };

  for (const [pumpId, state] of Object.entries(prev)) {
    if (
      !state.eventId ||
      (state.status !== 'queued' && state.status !== 'running')
    ) {
      continue;
    }

    const live =
      input.currentDose?.id === state.eventId
        ? input.currentDose
        : (input.queue.find((e) => e.id === state.eventId) ?? null);

    if (!live) {
      // Left the live queue. No verdict available yet (history fetch still
      // in flight or not refreshed): keep the current state — the next poll
      // resolves it. Never guess.
      const finished = input.history.find((h) => h.id === state.eventId);
      if (!finished) continue;
      next[pumpId] = outcomeState(finished, state.eventId);
    } else if (live.status === 'running') {
      next[pumpId] = {
        status: 'running',
        message: 'Dosing…',
        eventId: state.eventId,
      };
    } else if (live.status === 'queued') {
      const position = input.queue.findIndex((e) => e.id === state.eventId) + 1;
      next[pumpId] = {
        status: 'queued',
        message: `Queued #${position}`,
        eventId: state.eventId,
      };
    } else {
      // Terminal status can arrive straight from the live queue on a fast
      // poll — same verdict logic as the history path.
      next[pumpId] = outcomeState(live, state.eventId);
    }
  }

  return next;
}
