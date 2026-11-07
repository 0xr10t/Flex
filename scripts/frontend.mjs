// Builds the static install site and docs into dist/install/; --serve previews only that built folder.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'frontend');
const output = join(root, 'dist/install');

// The docs, in sidebar order. Each page's body lives in frontend/docs/<slug>.html.
const pages = [
  ['', 'Overview'],
  ['install', 'Installation'],
  ['first-run', 'First run'],
  ['using', 'Using Flex'],
  ['recurring', 'Recurring payments'],
  ['security', 'Security'],
  ['troubleshooting', 'Troubleshooting'],
  ['updating', 'Updating and removing'],
];

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'fonts'), { recursive: true });
for (const name of ['index.html', 'site.css', 'install.js']) copyFileSync(join(source, name), join(output, name));
copyFileSync(join(root, 'install.sh'), join(output, 'install.sh'));
copyFileSync(join(root, 'assets/logo.png'), join(output, 'logo.png'));
// The same self-hosted fonts as the wallet's approval page, so the two look alike without a second copy in the repo.
for (const name of ['archivo.woff2', 'jetbrains-mono.woff2', 'OFL-archivo.txt', 'OFL-jetbrains-mono.txt'])
  copyFileSync(join(root, 'wallet/src/browser/fonts', name), join(output, 'fonts', name));

const layout = readFileSync(join(source, 'docs/layout.html'), 'utf8');
pages.forEach(([slug, title], index) => {
  const base = slug ? '../../' : '../';
  const link = (target) => `${base}docs/${target ? `${target}/` : ''}`;
  const nav = pages
    .map(([other, label]) => `<a href="${link(other)}"${other === slug ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('\n');
  const [previous, next] = [pages[index - 1], pages[index + 1]];
  const pager = [
    previous
      ? `<a class="previous" href="${link(previous[0])}"><span>Previous</span>${previous[1]}</a>`
      : '<span></span>',
    next ? `<a class="next" href="${link(next[0])}"><span>Next</span>${next[1]}</a>` : '',
  ].join('\n');
  const html = layout
    .replaceAll('{{root}}', base)
    .replace('{{title}}', title)
    .replace('{{nav}}', nav)
    .replace('{{pager}}', pager)
    .replace('{{content}}', readFileSync(join(source, 'docs', `${slug || 'index'}.html`), 'utf8'));
  mkdirSync(join(output, 'docs', slug), { recursive: true });
  writeFileSync(join(output, 'docs', slug, 'index.html'), html);
});

if (process.argv.includes('--serve')) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.sh': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
  };
  const server = createServer((request, response) => {
    const notFound = () => response.writeHead(404).end('Not found');
    if (!['GET', 'HEAD'].includes(request.method)) return notFound();
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      return notFound();
    }
    // Only files inside the built folder are reachable, never the repository or its .env.
    let file = resolve(output, `.${pathname}`);
    if (file !== output && !file.startsWith(output + sep)) return notFound();
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!pathname.endsWith('/')) return response.writeHead(301, { Location: `${pathname}/` }).end();
      file = join(file, 'index.html');
    }
    if (!existsSync(file) || !statSync(file).isFile() || !types[extname(file)]) return notFound();
    response.writeHead(200, {
      'Content-Type': types[extname(file)],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : readFileSync(file));
  });
  server.on('error', (error) => {
    console.error(`Install page: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => {
    console.log(`Flex install page: http://127.0.0.1:${server.address().port}`);
  });
} else {
  console.log(`Built Flex install page and docs: ${relative(process.cwd(), output) || output}`);
}
