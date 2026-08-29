import { StyleSheet, View } from 'react-native';
import Svg, { Path, Text as SvgText } from 'react-native-svg';

import { Theme } from '@/constants/Theme';

const T = Theme;

interface SharlayWordmarkProps {
  width?: number;
  color?: string;
}

export function SharlayWordmark({
  width = 160,
  color = T.colors.textPrimary,
}: SharlayWordmarkProps) {
  const height = width / 7;
  const fontSize = 28;
  const baseline = 30;
  const font = T.typography.fontFamily.semiBold;

  const letters = [
    { char: 'S', x: 4 },
    { char: 'H', x: 44 },
    { char: 'A', x: 84 },
    { char: 'R', x: 124 },
    { char: 'L', x: 164 },
    { char: 'A', x: 204 },
    { char: 'Y', x: 244 },
  ];

  return (
    <View style={styles.container}>
      <Svg width={width} height={height} viewBox="0 0 280 40">
        {letters.map((letter) => (
          <SvgText
            key={letter.x}
            x={letter.x}
            y={baseline}
            fill={color}
            fontFamily={font}
            fontSize={fontSize}
            letterSpacing={2}>
            {letter.char}
          </SvgText>
        ))}

        {/* Aqua wave through the first A */}
        <Path
          d="M 88 21 C 96 15, 104 27, 116 21"
          fill="none"
          stroke={T.colors.primary}
          strokeWidth="3.5"
          strokeLinecap="round"
        />

        {/* Violet wave through the second A */}
        <Path
          d="M 208 21 C 216 15, 224 27, 236 21"
          fill="none"
          stroke={T.colors.accent}
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
