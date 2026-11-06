// tsc copies no JSON, and the envelope schema is read at runtime.
import { copyFileSync } from 'node:fs';

copyFileSync('src/schemas/handoff-envelope.schema.json', 'dist/src/schemas/handoff-envelope.schema.json');
