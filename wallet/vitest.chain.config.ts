import { defineConfig } from 'vitest/config';

// Runs transactions only against local Anvil chains. Needs Foundry (`anvil`, `forge`) on PATH.
// Opt-in FLEX_NATIVE_CRE tests additionally authenticate the CLI and read public mock-forwarder bytecode.
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
