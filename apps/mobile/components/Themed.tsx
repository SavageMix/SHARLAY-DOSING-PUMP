import {
  Text as DefaultText,
  TextInput as DefaultTextInput,
  View as DefaultView,
} from 'react-native';

import { useColorScheme } from './useColorScheme';

import Colors from '@/constants/Colors';
import { Theme } from '@/constants/Theme';

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const theme = 'dark';
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  return (
    <DefaultText
      style={[
        {
          color,
          fontFamily: Theme.typography.fontFamily.regular,
        },
        style,
      ]}
      {...otherProps}
    />
  );
}
export const ThemedText = Text;

export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor(
    { light: lightColor, dark: darkColor },
    'background'
  );

  return (
    <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />
  );
}
export const ThemedView = View;

export type TextInputProps = ThemeProps & DefaultTextInput['props'];

export function TextInput(props: TextInputProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  return (
    <DefaultTextInput
      style={[
        {
          color,
          fontFamily: Theme.typography.fontFamily.regular,
        },
        style,
      ]}
      {...otherProps}
    />
  );
}
export const ThemedTextInput = TextInput;
