// tsc copies no JSON, and the envelope schema is read at runtime.
import { copyFileSync, mkdirSync } from 'node:fs';

copyFileSync('src/schemas/handoff-envelope.schema.json', 'dist/src/schemas/handoff-envelope.schema.json');
mkdirSync('dist/src/browser', { recursive: true });
for (const file of ['ui.html', 'ui.js', 'ui.css']) copyFileSync(`src/browser/${file}`, `dist/src/browser/${file}`);
