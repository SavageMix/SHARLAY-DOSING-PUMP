import { Gpio } from 'pigpio';
import type { PumpId } from '@reef/shared';

// -----------------------------------------------------------------------------
// GPIO pin map — BCM numbering. EN is active-LOW, one per pump, with a 10k
// pull-up to 3.3V on each pin. HIGH or Hi-Z = disabled; LOW = enabled.
// -----------------------------------------------------------------------------
export const GPIO_PINS = {
  step: {
    alk: 24,
    ca: 25,
    no3: 12,
    po4: 16,
  },
  dir: 27,
  en: {
    alk: 5,
    ca: 6,
    no3: 13,
    po4: 26,
  },
} as const;

const ALL_PUMP_IDS: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

const enPins: Record<PumpId, Gpio> = {
  alk: new Gpio(GPIO_PINS.en.alk, { mode: Gpio.OUTPUT }),
  ca: new Gpio(GPIO_PINS.en.ca, { mode: Gpio.OUTPUT }),
  no3: new Gpio(GPIO_PINS.en.no3, { mode: Gpio.OUTPUT }),
  po4: new Gpio(GPIO_PINS.en.po4, { mode: Gpio.OUTPUT }),
};

// On module load: disable every driver before anything else can run.
for (const pumpId of ALL_PUMP_IDS) {
  enPins[pumpId].digitalWrite(1);
}

export function driversEnable(pumpId: PumpId): void {
  enPins[pumpId].digitalWrite(0);
}

export function driversDisable(): void {
  for (const pumpId of ALL_PUMP_IDS) {
    enPins[pumpId].digitalWrite(1);
  }
}

export function readEnableState(pumpId: PumpId): number {
  return enPins[pumpId].digitalRead();
}

const stepPins: Record<PumpId, Gpio> = {
  alk: new Gpio(GPIO_PINS.step.alk, { mode: Gpio.OUTPUT }),
  ca: new Gpio(GPIO_PINS.step.ca, { mode: Gpio.OUTPUT }),
  no3: new Gpio(GPIO_PINS.step.no3, { mode: Gpio.OUTPUT }),
  po4: new Gpio(GPIO_PINS.step.po4, { mode: Gpio.OUTPUT }),
};

// -----------------------------------------------------------------------------
// Configure STEP and DIR pins as outputs, all LOW.
// EN pins are handled separately at module load and are NOT touched here.
// -----------------------------------------------------------------------------
export function configurePins(): void {
  const dirPin = new Gpio(GPIO_PINS.dir, { mode: Gpio.OUTPUT });

  for (const pumpId of ALL_PUMP_IDS) {
    stepPins[pumpId].digitalWrite(0);
  }
  dirPin.digitalWrite(0);
}

// -----------------------------------------------------------------------------
// Shutdown handler: always leave every driver disabled.
// -----------------------------------------------------------------------------
export function shutdown(): void {
  driversDisable();
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in device process:', error);
  shutdown();
  process.exit(1);
});
