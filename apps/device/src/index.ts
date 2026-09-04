import { fileURLToPath } from 'node:url';
import { createEngine } from './engine.js';
import { ReefDatabase } from './db.js';
import { createScheduler } from './scheduler.js';
import { createServer } from './server.js';
import { waitForClockSync } from './clock-sync.js';

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
  const engine = createEngine(db);
  const scheduler = createScheduler(db, engine);
  const server = await createServer(db, engine);

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
      'Clock NOT synchronized after 120s — treating intervening doses as missed',
    );
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
