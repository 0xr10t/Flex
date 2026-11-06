import { defineConfig } from 'vitest/config';

// Runs against local anvil chains. Needs Foundry (`anvil`, `forge`) on the PATH. Nothing reaches a real network.
export default defineConfig({
  test: {
    include: ['test/chain/**/*.test.ts'],
    globalSetup: ['test/chain/build-contracts.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
