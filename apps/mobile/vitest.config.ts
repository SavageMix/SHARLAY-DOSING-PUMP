import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { reactNative } from 'vitest-native';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [reactNative()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
