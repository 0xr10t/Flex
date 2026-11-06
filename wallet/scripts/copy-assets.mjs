// tsc copies no JSON, and the envelope schema is read at runtime.
import { copyFileSync, mkdirSync } from 'node:fs';
import { URL } from 'node:url';

copyFileSync(
  new URL('../src/schemas/handoff-envelope.schema.json', import.meta.url),
  new URL('../dist/src/schemas/handoff-envelope.schema.json', import.meta.url),
);
mkdirSync(new URL('../dist/src/browser', import.meta.url), { recursive: true });
for (const file of ['ui.html', 'ui.js', 'ui.css'])
  copyFileSync(new URL(`../src/browser/${file}`, import.meta.url), new URL(`../dist/src/browser/${file}`, import.meta.url));
