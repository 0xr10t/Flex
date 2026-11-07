// Copies non-TS runtime assets (schema.sql, prompt texts, JSON schemas) into dist/.
import { cpSync, mkdirSync } from 'node:fs';
const pairs = [
  ['src/db/schema.sql', 'dist/src/db/schema.sql'],
  ['src/llm/prompts', 'dist/src/llm/prompts'],
  ['src/schemas', 'dist/src/schemas'],
  ['src/cli/onboarding/page', 'dist/src/cli/onboarding/page'],
];
for (const [from, to] of pairs) {
  mkdirSync(to.split('/').slice(0, -1).join('/'), { recursive: true });
  cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith('.ts') });
}
