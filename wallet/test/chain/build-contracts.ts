import { execFileSync } from 'node:child_process';

export default function buildContracts(): void {
  execFileSync('forge', ['build', '--root', new URL('../../contracts', import.meta.url).pathname], { stdio: 'ignore' });
}
