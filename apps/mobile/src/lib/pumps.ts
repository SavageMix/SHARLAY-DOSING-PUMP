import { Theme } from '@/constants/Theme';
import type { PumpId } from '@reef/shared';

const T = Theme;

export const PUMP_ORDER: PumpId[] = ['alk', 'ca', 'no3', 'po4'];

export const PUMP_DISPLAY_NAMES: Record<PumpId, string> = {
  alk: 'Alkalinity',
  ca: 'Calcium',
  no3: 'Nitrate',
  po4: 'Phosphate',
};

export const PUMP_COLORS: Record<PumpId, string> = {
  alk: T.colors.primary,
  ca: T.colors.accent,
  no3: T.colors.danger,
  po4: T.colors.success,
};

export const PUMP_SHORT_NAMES: Record<PumpId, string> = {
  alk: 'Alk',
  ca: 'Ca',
  no3: 'NO3',
  po4: 'PO4',
};
