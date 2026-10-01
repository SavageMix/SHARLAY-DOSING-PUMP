import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.js';
import { ReefDatabase } from './db.js';
import { createScheduler } from './scheduler.js';
import { createServer } from './server.js';
import { waitForClockSync } from './clock-sync.js';
import { isCalibrating } from './calibrator.js';
import { isPriming } from './primer.js';
import {
  detectMissedDoses,
  detectMissedDosesWithUntrustedClock,
} from './missed-doses.js';
import { runIntegrityAudit } from './audit.js';

// The default DB lives next to the compiled output (apps/device/reef-doser.db)
// rather than being resolved from the process CWD. A relative './reef-doser.db'
// silently points at a DIFFERENT database when the server is started manually
// from the repo root instead of the systemd unit's WorkingDirectory — schedules
// then "save" but vanish on the next proper boot.
const DB_PATH =
  process.env.REEF_DB_PATH ??
  fileURLToPath(new URL('../reef-doser.db', import.meta.url));
const PORT = Number(process.env.REEF_PORT ?? 8000);
const HOST = process.env.REEF_HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  console.log(`Database: ${DB_PATH}`);
  const db = new ReefDatabase(DB_PATH);

  const engine = createEngine(db, {
    // Global motor lock: prime and calibration own the motor outside the
    // dose queue; the engine waits for them before energising any driver.
    isMotorBusy: () =>
      isPriming() ||
      (['alk', 'ca', 'no3', 'po4'] as const).some((id) => isCalibrating(id)),
  });
  const scheduler = createScheduler(db, engine);

  // Integrity findings are served LIVE: the getter re-runs the SELECT-only
  // audit on every /api/status request (the DB is ~1k records, so this is
  // milliseconds). Findings therefore clear as soon as a slot gains a
  // resolution (a missed-dose entry or a fired dose) instead of lingering
  // as a boot-time snapshot, and new inconsistencies surface without a
  // restart. The audit never writes, so this is safe to re-run.
  const server = await createServer(db, engine, {
    getIntegrityFindings: () =>
      runIntegrityAudit(db.createAuditStore(), new Date()).findings,
  });

  // Start the API server immediately so the app can connect and show status
  // even while we wait for the system clock to become trustworthy.
  await server.listen(PORT, HOST);

  // Wait for NTP synchronization before making scheduling decisions. A Pi
  // without an RTC can boot with a fake-hwclock timestamp from shutdown, which
  // would cause the scheduler to fire doses that were actually missed while
  // the device was off.
  const clockTrusted = await waitForClockSync();
  if (clockTrusted) {
    console.log('Clock synchronized, scheduler armed');
  } else {
    console.log(
      'Clock NOT synchronized after 300s — treating intervening doses as missed',
    );
  }

  // Missed-dose detection MUST run before the integrity audit: detection
  // resolves overdue slots by creating pending missed-dose entries for them,
  // and the audit's 'unresolved-slot' check treats any missed_doses row as a
  // resolution. Running the audit first raised findings for slots detection
  // resolved ~30s later. This mirrors the detection scheduler.start()
  // performs; that re-run is then a no-op because lastRunAt has advanced.
  if (clockTrusted) {
    detectMissedDoses(db, new Date());
  } else {
    detectMissedDosesWithUntrustedClock(db, new Date());
  }

  // Boot-time integrity audit — a SELECT-only observer. Runs after the
  // database's boot reconciliation (inside the constructor) so the
  // 'stuck-confirmed' check verifies that pass actually ran, and after
  // missed-dose detection so check 3 sees the true post-detection state. It
  // never writes, never touches the engine, and never fires/repairs/dismisses
  // anything. Logged once here; /api/status serves findings live via the
  // getter above.
  const audit = runIntegrityAudit(db.createAuditStore(), new Date());
  if (audit.findings.length === 0) {
    console.log(
      `[audit] integrity check passed — ${audit.verified} records verified`,
    );
  } else {
    for (const finding of audit.findings) {
      console.warn(`[audit] FINDING [${finding.check}] ${finding.message}`);
    }
  }

  scheduler.start({ clockTrusted });

  const shutdown = async () => {
    console.log('Shutting down...');
    scheduler.stop();
    await server.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
