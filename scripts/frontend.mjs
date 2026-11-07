// Static install page only; never serve repository files or local configuration.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = new URL('../', import.meta.url);
const output = new URL('dist/install/', root);
mkdirSync(output, { recursive: true });
for (const name of ['index.html', 'install.css', 'install.js']) {
  copyFileSync(new URL(`frontend/${name}`, root), new URL(name, output));
}
copyFileSync(new URL('install.sh', root), new URL('install.sh', output));

if (process.argv.includes('--serve')) {
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/install.css', ['install.css', 'text/css; charset=utf-8']],
    ['/install.js', ['install.js', 'text/javascript; charset=utf-8']],
    ['/install.sh', ['install.sh', 'text/plain; charset=utf-8']],
  ]);
  const server = createServer((request, response) => {
    const file = files.get(new URL(request.url, 'http://localhost').pathname);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': file[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : readFileSync(new URL(file[0], output)));
  });
  server.on('error', (error) => {
    console.error(`Install page: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => {
    console.log(`Flex install page: http://127.0.0.1:${server.address().port}`);
  });
} else {
  console.log(`Built Flex install page: ${fileURLToPath(output)}`);
}
