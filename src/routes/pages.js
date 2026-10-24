import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setShellHeaders } from '../security.js';
import { PUBLIC_DIR } from '../paths.js';

const cache = new Map();
export function page(name) {
  if (!cache.has(name)) cache.set(name, readFileSync(join(PUBLIC_DIR, 'pages', `${name}.html`), 'utf8'));
  return cache.get(name);
}

export function sendPage(reply, name, { admin = false, status = 200 } = {}) {
  setShellHeaders(reply, { admin });
  return reply.code(status).type('text/html; charset=utf-8').send(page(name));
}

// D7. Only a logged-in admin session counts as "admin" here: the implicit
// admin access of a local-direct request still follows the redirect rules.
export async function rootTarget(ctx, req) {
  if (ctx.auth.getSession(req)?.admin) return { page: 'list' };
  const { featured, publicListing } = ctx.config;
  const slugs = await ctx.decks.slugs();
  if (ctx.decks.single) return slugs.length ? { redirect: `/${slugs[0]}` } : { page: 'landing' };
  if (featured && slugs.includes(featured)) return { redirect: `/${featured}` };
  if (slugs.length === 1) return { redirect: `/${slugs[0]}` };
  return { page: publicListing ? 'list' : 'landing' };
}

export function registerPages(app, ctx) {
  const { auth, decks } = ctx;

  app.get('/', async (req, reply) => {
    const target = await rootTarget(ctx, req);
    if (target.redirect) return reply.redirect(target.redirect, 302);
    return sendPage(reply, target.page);
  });

  app.get('/robots.txt', async (req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  // Browsers ask for /favicon.ico on their own; a PNG under that name works.
  const favicon = readFileSync(join(PUBLIC_DIR, 'favicon.png'));
  app.get('/favicon.ico', async (req, reply) => reply.type('image/png').header('Cache-Control', 'public, max-age=86400').send(favicon));

  async function deckPage(req, reply, { need, name }) {
    const { slug } = req.params;
    if (!(await decks.exists(slug))) return sendPage(reply, 'notfound', { status: 404 });
    const ok = need === 'present' ? auth.canPresent(req, slug) : auth.canView(req, slug);
    if (!ok) {
      const as = need === 'present' ? 'presenter' : 'viewer';
      return reply.redirect(`/${slug}/login?as=${as}`, 302);
    }
    return sendPage(reply, name);
  }

  app.get('/:slug', (req, reply) => deckPage(req, reply, { need: 'view', name: 'selector' }));
  app.get('/:slug/view', (req, reply) => deckPage(req, reply, { need: 'view', name: 'viewer' }));
  app.get('/:slug/present', (req, reply) => deckPage(req, reply, { need: 'present', name: 'presenter' }));
  app.get('/:slug/login', async (req, reply) => {
    if (!(await decks.exists(req.params.slug))) return sendPage(reply, 'notfound', { status: 404 });
    return sendPage(reply, 'login');
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not-found' });
    return sendPage(reply, 'notfound', { status: 404 });
  });
}
