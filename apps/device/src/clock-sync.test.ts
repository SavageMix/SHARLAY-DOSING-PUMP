import { describe, expect, it, vi } from 'vitest';
import { waitForClockSync } from '../src/clock-sync.js';

describe('waitForClockSync', () => {
  it('returns true immediately when the clock is already synchronized', async () => {
    let calls = 0;
    const checkSync = vi.fn().mockImplementation(async () => {
      calls++;
      return true;
    });

    const result = await waitForClockSync({
      timeoutMs: 1000,
      pollIntervalMs: 100,
      checkSync,
    });

    expect(result).toBe(true);
    expect(calls).toBe(1);
  });

  it('returns false after the timeout if the clock never synchronizes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const checkSync = vi.fn().mockResolvedValue(false);

    const promise = waitForClockSync({
      timeoutMs: 1000,
      pollIntervalMs: 100,
      checkSync,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe(false);
    expect(checkSync).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('polls until synchronization succeeds before the timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let calls = 0;
    const checkSync = vi.fn().mockImplementation(async () => {
      calls++;
      return calls >= 3;
    });

    const promise = waitForClockSync({
      timeoutMs: 1000,
      pollIntervalMs: 100,
      checkSync,
    });

    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result).toBe(true);
    expect(calls).toBe(3);

    vi.useRealTimers();
  });
});
