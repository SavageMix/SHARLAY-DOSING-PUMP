import { describe, expect, it, vi } from 'vitest';
import { installSignalOverrides } from './signals.js';

describe('installSignalOverrides', () => {
  it('overrides pigpio handlers: SIGCONT/SIGTSTP non-fatal, SIGHUP requests shutdown', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onHangup = vi.fn();
    const contBefore = process.listenerCount('SIGCONT');
    installSignalOverrides({ onHangup });
    expect(process.listenerCount('SIGCONT')).toBe(contBefore + 1);

    // SIGCONT: systemd sends this on every `systemctl stop` — it must never
    // terminate the process (pigpio's C handler would exit 255).
    const cont = process.listeners('SIGCONT').at(-1) as () => void;
    expect(() => cont()).not.toThrow();
    expect(onHangup).not.toHaveBeenCalled();

    // SIGTSTP: Ctrl-Z must not crash either.
    const tstp = process.listeners('SIGTSTP').at(-1) as () => void;
    expect(() => tstp()).not.toThrow();
    expect(onHangup).not.toHaveBeenCalled();

    // SIGHUP: conventionally "terminal gone" — route to clean shutdown.
    const hup = process.listeners('SIGHUP').at(-1) as () => void;
    hup();
    expect(onHangup).toHaveBeenCalledTimes(1);

    // Leave the runner process as we found it.
    process.removeListener('SIGCONT', cont);
    process.removeListener('SIGTSTP', tstp);
    process.removeListener('SIGHUP', hup);
    logSpy.mockRestore();
  });

  it('is idempotent — repeated calls add no duplicate listeners', () => {
    installSignalOverrides({});
    const contCount = process.listenerCount('SIGCONT');
    installSignalOverrides({});
    expect(process.listenerCount('SIGCONT')).toBe(contCount);
    // Cleanup so the runner process is left as we found it.
    for (const sig of ['SIGCONT', 'SIGTSTP', 'SIGHUP'] as const) {
      for (const l of process.listeners(sig)) {
        process.removeListener(sig, l);
      }
    }
  });
});
