import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface ClockSyncOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  checkSync?: () => Promise<boolean>;
}

/**
 * Poll the system clock until NTP synchronization is reported by timedatectl,
 * or the timeout expires.
 *
 * Returns true if the clock is synchronized, false if the timeout was reached.
 */
export async function waitForClockSync(
  options: ClockSyncOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const checkSync = options.checkSync ?? checkNtpSynchronized;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const synced = await checkSync();
      if (synced) {
        return true;
      }
    } catch (error) {
      console.error('Clock sync check failed:', error);
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

async function checkNtpSynchronized(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      'timedatectl show --property=NTPSynchronized --value',
    );
    return stdout.trim() === 'yes';
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
