import { Palette, Theme } from './Theme';

const semantic = {
  text: Theme.colors.textPrimary,
  background: Theme.colors.background,
  tint: Theme.colors.primary,
  tabIconDefault: Theme.colors.textSecondary,
  tabIconSelected: Theme.colors.primary,

  primary: Theme.colors.primary,
  accent: Theme.colors.accent,
  danger: Theme.colors.danger,
  success: Theme.colors.success,
  warning: Theme.colors.warning,

  // Legacy raw aliases — keep existing consumers compiling.
  aqua: Palette.electricAqua,
  violet: Palette.reefViolet,
  coral: Palette.coralBloom,
  blue: Palette.electricAqua,
  pearl: Palette.pearl,
  titanium: Palette.titanium,
  slate: Palette.slate,
  obsidian: Palette.obsidian,
  abyss: Palette.abyss,
  midnight: Palette.midnight,
};

export default {
  light: semantic,
  dark: semantic,
};
