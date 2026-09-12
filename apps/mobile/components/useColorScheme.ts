import { useColorScheme as useColorSchemeCore } from 'react-native';

export const useColorScheme = () => {
  const coreScheme = useColorSchemeCore();
  // 'unspecified' is not in modern RN's ColorSchemeName, but keep the guard
  // for older runtimes — the cast widens only the type, not the behaviour.
  return (coreScheme as string) === 'unspecified' ? 'light' : coreScheme;
};
