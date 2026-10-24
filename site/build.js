// Builds the website into _site/, the folder GitHub Pages publishes.
//   node site/build.js           build
//   node site/build.js --serve   build and serve it at http://127.0.0.1:8080
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, '_site');

// [source in the repo, destination in _site]
const FILES = [
  ['site/index.html', 'index.html'],
  ['site/style.css', 'style.css'],
  ['site/main.js', 'main.js'],
  ['site/media', 'media'],
  ['public/logo.svg', 'assets/logo.svg'],
  ['public/favicon.png', 'assets/favicon.png'],
  ['public/apple-touch-icon.png', 'assets/apple-touch-icon.png'],
  ['docs/assets/social-preview.png', 'assets/social-preview.png'],
];

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'assets'), { recursive: true });
for (const [from, to] of FILES) await cp(join(repo, from), join(out, to), { recursive: true });
console.log('Built _site/');

if (process.argv.includes('--serve')) {
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm',
  };
  createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(out, path.endsWith('/') ? join(path, 'index.html') : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }).listen(8080, '127.0.0.1', () => console.log('Serving http://127.0.0.1:8080'));
}
