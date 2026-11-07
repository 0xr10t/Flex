// tsc copies no assets, and the browser approval page is served from dist at runtime.
import { copyFileSync, mkdirSync } from 'node:fs';
import { URL } from 'node:url';

mkdirSync(new URL('../dist/src/browser/fonts', import.meta.url), { recursive: true });
for (const file of [
  'ui.html',
  'ui.js',
  'ui.css',
  'fonts/archivo.woff2',
  'fonts/jetbrains-mono.woff2',
  'fonts/OFL-archivo.txt',
  'fonts/OFL-jetbrains-mono.txt',
])
  copyFileSync(
    new URL(`../src/browser/${file}`, import.meta.url),
    new URL(`../dist/src/browser/${file}`, import.meta.url),
  );
