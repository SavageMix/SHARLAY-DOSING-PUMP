import { createEngine } from './engine.js';
import { ReefDatabase } from './db.js';
import { createScheduler } from './scheduler.js';
import { createServer } from './server.js';

const DB_PATH = process.env.REEF_DB_PATH ?? './reef-doser.db';
const PORT = Number(process.env.REEF_PORT ?? 8000);
const HOST = process.env.REEF_HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const db = new ReefDatabase(DB_PATH);
  const engine = createEngine(db);
  const scheduler = createScheduler(db, engine);
  const server = createServer(db, engine);

  scheduler.start();
  await server.listen(PORT, HOST);

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
