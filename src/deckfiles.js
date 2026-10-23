import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGzip, gzipSync } from 'node:zlib';
import { resolve, sep, extname, join } from 'node:path';
import { verifyDeckToken } from './tokens.js';

export const DECK_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";
export const BRIDGE_TAG = '<script src="/_syncdeck/bridge.js"></script>';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|wasm)|image\/svg)/;

// Inserts the bridge as the first element of <head>, so it runs before any deck script.
export function injectBridge(html) {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + BRIDGE_TAG + html.slice(at);
  }
  // No <head>: put it after <html> or the doctype, never before the doctype
  // (that would switch the page to quirks mode).
  const anchor = /<html(\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    return html.slice(0, at) + BRIDGE_TAG + html.slice(at);
  }
  return BRIDGE_TAG + html;
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
}

export function registerDeckFiles(app, ctx) {
  app.get('/_deck/:slug/:token/*', async (req, reply) => {
    const { slug, token } = req.params;
    if (!verifyDeckToken(ctx.config.secret, slug, token)) return reply.code(403).send('Forbidden');
    const deckDir = ctx.decks.dirOf(slug);
    if (!deckDir || !(await ctx.decks.exists(slug))) return reply.code(404).send('Not found');

    const rel = req.params['*'] ?? '';
    if (rel.includes('\0')) return reply.code(403).send('Forbidden');
    let target = resolve(deckDir, rel);
    const root = await realpath(deckDir);
    if (target !== deckDir && !target.startsWith(deckDir + sep)) return reply.code(403).send('Forbidden');
    let st;
    try {
      st = await stat(target);
      if (st.isDirectory()) {
        target = join(target, 'index.html');
        st = await stat(target);
      }
      const real = await realpath(target);
      if (!real.startsWith(root + sep)) return reply.code(403).send('Forbidden');
    } catch {
      return reply.code(404).send('Not found');
    }
    if (!st.isFile() || target === join(deckDir, 'deck.json')) return reply.code(404).send('Not found');

    // Every deck file gets the sandbox CSP: an HTML or SVG file opened directly
    // must not run on syncdeck's origin either.
    reply.header('Content-Security-Policy', DECK_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Vary', 'Accept-Encoding');

    if (target === join(deckDir, 'index.html')) {
      const html = injectBridge(await readFile(target, 'utf8'));
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache');
      if (acceptsGzip(req)) {
        reply.header('Content-Encoding', 'gzip');
        return reply.send(gzipSync(html));
      }
      return reply.send(html);
    }

    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('Content-Type', type);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const stream = createReadStream(target);
    if (COMPRESSIBLE.test(type) && acceptsGzip(req)) {
      reply.header('Content-Encoding', 'gzip');
      return reply.send(stream.pipe(createGzip()));
    }
    reply.header('Content-Length', st.size);
    return reply.send(stream);
  });
}
