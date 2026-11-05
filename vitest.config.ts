import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/acceptance/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**'],
    environment: 'node',
    pool: 'forks',
  },
});
