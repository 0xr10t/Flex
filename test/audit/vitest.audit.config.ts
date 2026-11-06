// Run the audit suite: npm run test:audit
// (test/audit is deliberately outside the root vitest.config.ts `include`.)
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: join(import.meta.dirname, '..', '..'),
  test: {
    include: ['test/audit/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    pool: 'forks',
  },
});
