import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/acceptance/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
