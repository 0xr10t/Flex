import { copyFileSync } from 'node:fs';
copyFileSync(new URL('./src/schemas/handoff-envelope.schema.json', import.meta.url), new URL('./dist/schemas/handoff-envelope.schema.json', import.meta.url));
