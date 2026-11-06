import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'cre/autopay/test/**/*.test.ts'],
    environment: 'node',
    // The CRE SDK targets a bundler and publishes extensionless ESM imports.
    server: { deps: { inline: [/@chainlink\/cre-sdk/] } },
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
