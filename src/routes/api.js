import { issueDeckToken } from '../tokens.js';

export function registerApi(app, ctx) {
  const { auth, decks, config, rooms } = ctx;

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  function deckUrl(slug) {
    return `/_deck/${slug}/${issueDeckToken(config.secret, slug)}/`;
  }

  // What a list card needs to draw its thumbnail: the cover image, or else the
  // deck itself (shown as a small preview). Locked decks get neither.
  function thumb(req, { slug, aspect, cover }) {
    if (!auth.canView(req, slug) || (!rooms.isOpen(slug) && !auth.canPresent(req, slug))) return { locked: true };
    const url = deckUrl(slug);
    return { aspect, deckUrl: url, cover: cover ? url + encodePath(cover) : null };
  }

  app.get('/api/decks', async (req, reply) => {
    if (auth.canAdmin(req)) {
      return { decks: (await decks.list()).map((d) => ({ ...d, ...thumb(req, d), open: rooms.isOpen(d.slug), listed: rooms.settings(d.slug).listed })) };
    }
    if (!config.publicListing) return reply.code(403).send({ error: 'forbidden' });
    const open = (await decks.list()).filter((d) => rooms.isListed(d.slug));
    return { decks: open.map((d) => ({ slug: d.slug, title: d.title, ...thumb(req, d) })) };
  });

  app.get('/api/decks/:slug', async (req, reply) => {
    const { slug } = req.params;
    const deck = await decks.get(slug);
    if (!deck) return reply.code(404).send({ error: 'not-found' });
    if (!auth.canView(req, slug)) return reply.code(403).send({ error: 'forbidden' });
    const canPresent = auth.canPresent(req, slug);
    const room = rooms.settings(slug);
    const out = {
      slug,
      title: deck.title,
      aspect: deck.meta.aspect,
      viewerNav: deck.meta.viewerNav,
      open: room.open,
      askNames: room.askNames,
      hands: room.hands,
      canPresent,
      canAdmin: auth.canAdmin(req),
    };
    // A closed room hands out no deck link to its audience (D4 of 0003).
    if (!room.open && !canPresent) return { ...out, deckUrl: null, cover: null };
    out.deckUrl = deckUrl(slug);
    out.cover = deck.cover ? out.deckUrl + encodePath(deck.cover) : null;
    if (canPresent) out.notes = deck.meta.slides;
    return out;
  });
}
