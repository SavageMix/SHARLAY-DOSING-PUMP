export const Colors = {
  obsidian: '#070A12',
  abyss: '#111827',
  midnight: '#182333',
  aqua: '#20E3D8',
  violet: '#8A5CFF',
  coral: '#FF5FA2',
  blue: '#2F80FF',
  pearl: '#F5F7FA',
  titanium: '#C6CED8',
  slate: '#6B7280',
  mist: '#9CA3AF',
  success: '#00D084',
  warning: '#FFB547',
  danger: '#FF4D5A',
  deepOcean: '#0D1B2A',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  hero: 64,
} as const;

export const Radius = {
  sm: 16,
  md: 24,
  lg: 32,
} as const;

export const Typography = {
  display: { fontSize: 40, fontWeight: '300' as const },
  h1: { fontSize: 32, fontWeight: '600' as const },
  h2: { fontSize: 24, fontWeight: '600' as const },
  h3: { fontSize: 20, fontWeight: '500' as const },
  title: { fontSize: 18, fontWeight: '500' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  small: { fontSize: 14, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '500' as const },
  tiny: { fontSize: 10, fontWeight: '500' as const },
} as const;

export const Shadows = {
  card: {
    shadowColor: Colors.aqua,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 40,
    elevation: 12,
  },
  floating: {
    shadowColor: Colors.violet,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.24,
    shadowRadius: 60,
    elevation: 18,
  },
  glow: {
    shadowColor: Colors.aqua,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 18,
    elevation: 8,
  },
};
