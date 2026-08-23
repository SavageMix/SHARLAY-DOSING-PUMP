import { runSteps } from './stepper.js';
import type { PumpId } from '@reef/shared';

const PUMPS: PumpId[] = ['alk', 'ca', 'no3', 'po4'];
const STEPS_PER_PUMP = 200;
const PAUSE_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  for (const pump of PUMPS) {
    console.log(`Running ${pump} pump: ${STEPS_PER_PUMP} steps`);
    await runSteps(pump, STEPS_PER_PUMP);
    console.log(`Finished ${pump}`);
    await sleep(PAUSE_MS);
  }
  console.log('All pumps cycled successfully');
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
