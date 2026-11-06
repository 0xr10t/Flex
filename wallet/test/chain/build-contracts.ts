import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export default function buildContracts(): void {
  execFileSync('forge', ['build', '--root', fileURLToPath(new URL('../../contracts', import.meta.url))], {
    stdio: 'ignore',
  });
}
