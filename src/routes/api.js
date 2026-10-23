import { issueDeckToken } from '../tokens.js';

export function registerApi(app, ctx) {
  const { auth, decks, config } = ctx;

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/api/decks', async (req, reply) => {
    if (auth.canAdmin(req)) return { decks: await decks.list() };
    if (!config.publicListing) return reply.code(403).send({ error: 'forbidden' });
    return { decks: (await decks.list()).map(({ slug, title }) => ({ slug, title })) };
  });

  app.get('/api/decks/:slug', async (req, reply) => {
    const { slug } = req.params;
    const deck = await decks.get(slug);
    if (!deck) return reply.code(404).send({ error: 'not-found' });
    if (!auth.canView(req, slug)) return reply.code(403).send({ error: 'forbidden' });
    const canPresent = auth.canPresent(req, slug);
    const out = {
      slug,
      title: deck.title,
      aspect: deck.meta.aspect,
      viewerNav: deck.meta.viewerNav,
      deckUrl: `/_deck/${slug}/${issueDeckToken(config.secret, slug)}/`,
      canPresent,
      canAdmin: auth.canAdmin(req),
    };
    if (canPresent) out.notes = deck.meta.slides;
    return out;
  });
}
