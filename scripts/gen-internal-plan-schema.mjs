// Regenerates src/schemas/internal-plan.schema.json from the §12.3 types in src/contracts/types.ts.
// Placeholder template-literal types are tightened to the §12.3 comment patterns.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const raw = execFileSync(
  'npx',
  [
    'ts-json-schema-generator',
    '--path',
    'src/contracts/types.ts',
    '--type',
    'InternalPlan',
    '--tsconfig',
    'tsconfig.json',
    '--no-type-check',
  ],
  { encoding: 'utf8' },
);
const schema = JSON.parse(raw);
schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
schema.$id = 'agent-layer/internal-plan/v2';
const defs = schema.definitions;
defs.AmountPh = { ...defs.AmountPh, pattern: '^amount_[0-9a-f]{8}$' };
defs.AddressPh = { ...defs.AddressPh, pattern: '^address_[0-9a-f]{8}$' };
let text = JSON.stringify(schema, null, 2);
text = text.replaceAll('"#/definitions/', '"#/$defs/').replace('"definitions":', '"$defs":');
writeFileSync('src/schemas/internal-plan.schema.json', text + '\n');
