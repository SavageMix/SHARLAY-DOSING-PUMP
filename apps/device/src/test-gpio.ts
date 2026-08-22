import { driversDisable, driversEnable, readEnableState } from './gpio.js';

function logEnStates(label: string): void {
  console.log(
    `${label}: alk=${readEnableState('alk')} ca=${readEnableState('ca')} ` +
      `no3=${readEnableState('no3')} po4=${readEnableState('po4')} ` +
      `(1=disabled, 0=enabled)`,
  );
}

logEnStates('Initial EN states');

console.log('Enabling alk driver for 2 seconds...');
driversEnable('alk');
logEnStates('After enable alk');

setTimeout(() => {
  console.log('Disabling all drivers...');
  driversDisable();
  logEnStates('After disable all');
  process.exit(0);
}, 2000);
