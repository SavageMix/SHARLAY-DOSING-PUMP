/**
 * Signal hygiene for the pigpio C library.
 *
 * At initialisation (the first `new Gpio(...)`) pigpio registers its own C
 * sigHandler for EVERY signal from PI_MIN_SIGNUM..PI_MAX_SIGNUM. Any signal
 * without a user function registered hits its `default:` branch:
 *
 *     "sigHandler: Unhandled signal %d, terminating"
 *     gpioTerminate(); exit(-1);   // status 255
 *
 * Two real-world senders hit that branch:
 *
 * - SIGCONT (18): systemd sends this to every service process as part of
 *   `systemctl stop`, right before the real kill signal. Every clean stop
 *   therefore died with status 255 and the unit was marked "Failed".
 * - SIGTSTP (20): Ctrl-Z on an interactive shell. Job-control suspension of
 *   a process driving steppers is a terrible idea anyway; swallowing it is
 *   safer than a fatal exit.
 * - SIGHUP (1):  conventionally means "controlling terminal gone" — treat
 *   as a clean shutdown request rather than a 255 crash.
 *
 * Installing a JS listener makes libuv re-register its own C-level handler
 * for that signal, which overrides pigpio's. This MUST run after the first
 * `new Gpio(...)` call (gpio.ts does that).
 */

let installed = false;

export interface SignalOverrideOptions {
  /** SIGHUP handler — the caller decides what "clean shutdown" means. */
  onHangup?: () => void;
}

export function installSignalOverrides(
  options: SignalOverrideOptions = {},
): void {
  if (installed) return;
  installed = true;

  process.on('SIGCONT', () => {
    // Informational only — systemd sends this before the stop signal
    // (SIGTERM), which our own handlers shut down on. Must not terminate.
    console.log('[signals] SIGCONT received — continuing');
  });

  process.on('SIGTSTP', () => {
    // Swallow: suspending the process mid-dose would freeze drivers in an
    // unknown state. Interactive stop should use SIGINT/SIGTERM instead.
    console.log('[signals] SIGTSTP received — ignoring (use SIGTERM to stop)');
  });

  process.on('SIGHUP', () => {
    console.log('[signals] SIGHUP received — clean shutdown');
    options.onHangup?.();
  });
}
