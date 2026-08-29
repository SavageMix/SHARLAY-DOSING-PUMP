/**
 * SHARLAY Design System tokens.
 *
 * Always reference the semantic `Theme` object in UI code. The legacy
 * top-level exports (Colors, Spacing, Radius, Typography, Shadows) are kept
 * for backward compatibility with existing screens during the migration.
 */

import {
  PlusJakartaSans_300Light,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';

// ---------------------------------------------------------------------------
// Raw brand palette — exact hex values from the SHARLAY brand board.
// ---------------------------------------------------------------------------
export const Palette = {
  obsidian: '#070A12',
  abyss: '#111827',
  midnight: '#182333',
  deepOcean: '#0D1B2A',

  electricAqua: '#20E3DB',
  sapphire: '#2F80FF',
  reefViolet: '#8A5CFF',
  coralBloom: '#FF5FA2',

  pearl: '#F5F7FA',
  titanium: '#C6CED8',
  slate: '#6B7280',
  mist: '#9CA3AF',

  success: '#00D084',
  warning: '#FFB547',
  danger: '#FF4D5A',
} as const;

// ---------------------------------------------------------------------------
// Semantic colour tokens. New code should reference these, never raw hex.
// ---------------------------------------------------------------------------
export const Theme = {
  colors: {
    background: Palette.obsidian,
    surface: Palette.abyss,
    surfaceElevated: Palette.midnight,
    surfaceOverlay: 'rgba(7, 10, 18, 0.85)',

    primary: Palette.electricAqua,
    sapphire: Palette.sapphire,
    accent: Palette.reefViolet,
    danger: Palette.coralBloom,
    success: Palette.success,
    warning: Palette.warning,

    textPrimary: Palette.pearl,
    textSecondary: Palette.titanium,
    textMuted: Palette.slate,

    border: 'rgba(32, 227, 219, 0.12)',
    borderActive: 'rgba(32, 227, 219, 0.35)',
    glow: 'rgba(32, 227, 219, 0.18)',
    overlay: 'rgba(0, 0, 0, 0.7)',
  },

  typography: {
    fontFamily: {
      light: 'PlusJakartaSans_300Light',
      regular: 'PlusJakartaSans_400Regular',
      medium: 'PlusJakartaSans_500Medium',
      semiBold: 'PlusJakartaSans_600SemiBold',
      bold: 'PlusJakartaSans_700Bold',
    } as const,

    h1: {
      fontSize: 32,
      lineHeight: 40,
      fontFamily: 'PlusJakartaSans_600SemiBold',
    } as const,
    h2: {
      fontSize: 24,
      lineHeight: 32,
      fontFamily: 'PlusJakartaSans_600SemiBold',
    } as const,
    h3: {
      fontSize: 20,
      lineHeight: 28,
      fontFamily: 'PlusJakartaSans_600SemiBold',
    } as const,
    title: {
      fontSize: 18,
      lineHeight: 24,
      fontFamily: 'PlusJakartaSans_500Medium',
    } as const,
    body: {
      fontSize: 16,
      lineHeight: 24,
      fontFamily: 'PlusJakartaSans_400Regular',
    } as const,
    small: {
      fontSize: 14,
      lineHeight: 20,
      fontFamily: 'PlusJakartaSans_400Regular',
    } as const,
    caption: {
      fontSize: 12,
      lineHeight: 16,
      fontFamily: 'PlusJakartaSans_500Medium',
    } as const,
    label: {
      fontSize: 10,
      lineHeight: 12,
      fontFamily: 'PlusJakartaSans_600SemiBold',
      letterSpacing: 0.8,
      textTransform: 'uppercase' as const,
    } as const,
  },

  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    hero: 32,
    giant: 48,
  } as const,

  radius: {
    sm: 12,
    md: 16,
    lg: 24,
    pill: 999,
  } as const,

  shadows: {
    card: {
      shadowColor: Palette.electricAqua,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 24,
      elevation: 8,
    } as const,
    elevated: {
      shadowColor: Palette.reefViolet,
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.12,
      shadowRadius: 32,
      elevation: 12,
    } as const,
    glow: {
      shadowColor: Palette.electricAqua,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.25,
      shadowRadius: 16,
      elevation: 6,
    } as const,
    inner: {
      shadowColor: Palette.electricAqua,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 0,
    } as const,
  },
} as const;

// ---------------------------------------------------------------------------
// Legacy exports — keep existing screens compiling. Prefer `Theme` for new code.
// ---------------------------------------------------------------------------
export const Colors = {
  obsidian: Palette.obsidian,
  abyss: Palette.abyss,
  midnight: Palette.midnight,
  deepOcean: Palette.deepOcean,
  aqua: Palette.electricAqua,
  violet: Palette.reefViolet,
  coral: Palette.coralBloom,
  pearl: Palette.pearl,
  titanium: Palette.titanium,
  slate: Palette.slate,
  mist: Palette.mist,
  success: Palette.success,
  warning: Palette.warning,
  danger: Palette.danger,
} as const;

// Legacy spacing/radius values — unchanged so existing screens stay intact.
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
  display: { ...Theme.typography.h1, fontSize: 40, lineHeight: 48 },
  h1: Theme.typography.h1,
  h2: Theme.typography.h2,
  h3: Theme.typography.h3,
  title: Theme.typography.title,
  body: Theme.typography.body,
  small: Theme.typography.small,
  caption: Theme.typography.caption,
  label: Theme.typography.label,
  tiny: { fontSize: 10, lineHeight: 12, fontFamily: Theme.typography.fontFamily.medium },
} as const;

export const Shadows = Theme.shadows;

// ---------------------------------------------------------------------------
// Font loading config for the root layout.
// ---------------------------------------------------------------------------
export const fontAssets = {
  PlusJakartaSans_300Light,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
};
