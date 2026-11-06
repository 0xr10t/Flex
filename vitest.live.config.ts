import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
