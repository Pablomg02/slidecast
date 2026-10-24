// Builds the website into _site/, the folder GitHub Pages publishes.
//   node site/build.js           build
//   node site/build.js --serve   build and serve it at http://127.0.0.1:8080
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
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

// The Spanish version, in _site/es/: the page and its script with every
// English fragment listed in site/i18n/es.js swapped for its Spanish one.
// The rest (styles, media, assets) is shared with the English page, one
// folder up.
const warn = (msg) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `warning: ${msg}`);
const { default: es } = await import('./i18n/es.js');
const translated = {};
for (const [file, pairs] of Object.entries(es)) {
  let text = await readFile(join(repo, 'site', file), 'utf8');
  for (const [en, tr] of pairs) {
    if (!text.includes(en)) warn(`site/i18n/es.js: no longer in site/${file}: ${en}`);
    text = text.replaceAll(en, tr);
  }
  translated[file] = text;
}
const english = await readFile(join(repo, 'site/index.html'), 'utf8');
for (const t of untranslated(english, translated['index.html'])) warn(`site/i18n/es.js: not translated yet: ${t}`);
const own = new Set(Object.keys(es));
translated['index.html'] = translated['index.html'].replace(/\b(href|src|poster)="(?![a-z]+:|#|\/)([^"]*)"/g,
  (m, attr, url) => (own.has(url) ? m : `${attr}="../${url}"`));
await mkdir(join(out, 'es'));
for (const [file, text] of Object.entries(translated)) await writeFile(join(out, 'es', file), text);
console.log('Built _site/');

// Text of the English page still in the Spanish one, leaving out code, the AI
// prompt and the words that are the same in both languages.
function untranslated(en, tr) {
  const SAME = new Set(['slidecast', 'GitHub', 'English', 'Español', 'Windows', 'macOS', 'Linux', 'README', 'nodejs.org',
    'Node.js', 'LTS', 'Terminal', '127.0.0.1:4321/admin', 'index.html', 'deck.json', 'intro', 'Ana', 'Leo', 'Sam',
    'website', 'summary_large_image', 'width=device-width, initial-scale=1']);
  const texts = (html) => {
    const body = html.replace(/<(pre|code|kbd|script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/g, '');
    const found = [...body.matchAll(/>([^<]+)</g)].map((m) => m[1])
      .concat([...body.matchAll(/\b(?:content|aria-label|data-label|title|alt)="([^"]+)"/g)].map((m) => m[1]));
    return new Set(found.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => /[a-z]{3}/i.test(t) && !/^(https?:|#)/.test(t) && !SAME.has(t)));
  };
  const left = texts(tr);
  return [...texts(en)].filter((t) => left.has(t));
}

if (process.argv.includes('--serve')) {
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4',
  };
  createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(out, path.endsWith('/') ? join(path, 'index.html') : path);
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      // Safari only plays video from servers that answer byte ranges.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start > end) return res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end();
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }).listen(8080, '127.0.0.1', () => console.log('Serving http://127.0.0.1:8080'));
}
