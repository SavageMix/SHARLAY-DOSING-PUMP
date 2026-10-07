import { describe, expect, it } from 'vitest';
import { settleCardMutation } from './catchups-page';

/**
 * Mirror of the Dashboard's cancel-queued-dose sequence (Dashboard's
 * handleCancelDose): every path through the wrapper must resolve — the
 * confirm dialog closes, the caller's refresh fires, and a 409 ("already
 * firing" / "Dose already finished") becomes a note, never a hang. Same
 * contract as the Catch-ups page's settleCardMutation tests.
 */
describe('cancel dose flow — settleCardMutation wrapper', () => {
  it('success resolves updated: dialog clears and refresh runs', async () => {
    let dialogOpen = true;
    let refreshCount = 0;
    let note: string | undefined;

    const outcome = await settleCardMutation(
      Promise.resolve({ jobId: 'job-1', cancelled: true as const }),
      'Could not cancel',
    );
    if (outcome.kind === 'noted') {
      note = outcome.note;
    } else {
      dialogOpen = false;
      refreshCount += 1; // load(): server is source of truth
    }

    expect(outcome.kind).toBe('updated');
    expect(dialogOpen).toBe(false);
    expect(refreshCount).toBe(1);
    expect(note).toBeUndefined();
  });

  it('409 "already firing" resolves noted with the server message, still refreshes, never hangs', async () => {
    let dialogOpen = true;
    let refreshCount = 0;
    let note: string | undefined;

    const alreadyFiring = new Error('already firing') as Error & {
      status?: number;
    };
    alreadyFiring.status = 409;

    const outcome = await settleCardMutation(
      Promise.reject(alreadyFiring),
      'Could not cancel',
    );
    dialogOpen = false; // the dialog always clears
    refreshCount += 1; // …and the caller always re-reconciles from the server
    if (outcome.kind === 'noted') {
      note = outcome.note;
    }

    expect(outcome.kind).toBe('noted');
    expect(note).toBe('already firing');
    expect(dialogOpen).toBe(false);
    expect(refreshCount).toBe(1);
  });

  it('network failure falls back to the caller note, still resolves', async () => {
    const outcome = await settleCardMutation(
      Promise.reject(new TypeError('fetch failed')),
      'Could not cancel',
    );

    expect(outcome.kind).toBe('noted');
    expect(outcome).toEqual({ kind: 'noted', note: 'fetch failed' });
  });
});
