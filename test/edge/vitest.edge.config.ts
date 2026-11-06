// Run the edge-case prompt suite: npx vitest run --config test/edge/vitest.edge.config.ts
// (test/edge is deliberately outside the root vitest.config.ts `include`, because it needs a local Ollama model.)
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: join(import.meta.dirname, '..', '..'),
  test: {
    include: ['test/edge/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
