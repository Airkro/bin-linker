import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.mts'],
      exclude: ['src/index.mts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
