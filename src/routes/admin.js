import { DeckError, isValidSlug } from '../decks.js';
import { saveConfig } from '../config.js';
import { checkPasswordInput } from '../auth.js';
import { sendPage } from './pages.js';
import { parseAppearance } from '../appearance.js';
import { parseRoomPatch } from '../rooms.js';

const UPLOAD_LIMIT = 100 * 1024 * 1024;
const PASSWORD_SCOPES = new Set(['admin', 'presenter', 'deckPresenter', 'deckViewer']);

const ERRORS = {
  ERR_BAD_SLUG: [400, 'bad-slug'],
  ERR_BAD_INPUT: [400, 'bad-request'],
  ERR_ZIP: [400, 'bad-zip'],
  ERR_NO_INDEX: [400, 'no-index'],
  ERR_NOT_FOUND: [404, 'not-found'],
  ERR_SINGLE_DECK: [409, 'single-deck'],
  ERR_BAD_META: [409, 'bad-deck-json'],
};

function sendError(reply, err) {
  if (!(err instanceof DeckError) && err.code !== 'ERR_ZIP') throw err;
  const [status, error] = ERRORS[err.code] ?? [400, 'bad-request'];
  return reply.code(status).send({ error, detail: err.message });
}

export function registerAdmin(app, ctx) {
  const { auth, decks, config, live, rooms } = ctx;

  // ---- pages ---------------------------------------------------------------
  const adminPage = (req, reply) => sendPage(ctx, reply, auth.canAdmin(req) ? 'admin' : 'admin-login', { admin: true });
  app.get('/admin', adminPage);
  app.get('/admin/', adminPage);
  app.get('/admin/edit/:slug', async (req, reply) => {
    if (!auth.canAdmin(req)) return reply.redirect('/admin', 302);
    if (!(await decks.exists(req.params.slug))) return sendPage(ctx, reply, 'notfound', { status: 404 });
    return sendPage(ctx, reply, 'editor', { admin: true });
  });

  // ---- API -----------------------------------------------------------------
  app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (!auth.canAdmin(req)) return reply.code(403).send({ error: 'forbidden' });
      return undefined;
    });
    // Uploads are the raw body (D20); these parsers exist only in this scope.
    scope.addContentTypeParser(['application/zip', 'text/html'], { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT },
      (req, body, done) => done(null, body));

    async function deckRows() {
      const rows = [];
      for (const d of await decks.list()) {
        const a = config.decks[d.slug] ?? {};
        rows.push({
          ...d,
          room: { ...rooms.settings(d.slug), ...live.counts(d.slug) },
          hasPresenterPassword: Boolean(a.presenterHash),
          hasViewerPassword: Boolean(a.viewerHash),
          viewerNav: (await decks.readMeta(d.slug)).viewerNav,
        });
      }
      return rows;
    }

    scope.get('/api/admin/decks', async () => ({ decks: await deckRows(), single: Boolean(decks.single) }));

    scope.post('/api/admin/decks', async (req, reply) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      const kind = type === 'application/zip' ? 'zip' : 'html';
      if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: 'empty-body' });
      try {
        const result = await decks.upload(String(req.query.slug ?? ''), req.body, kind);
        live.resetDeck(result.slug);
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    scope.delete('/api/admin/decks/:slug', async (req, reply) => {
      const { slug } = req.params;
      try {
        await decks.remove(slug);
      } catch (err) {
        return sendError(reply, err);
      }
      live.resetDeck(slug, { removed: true });
      await rooms.remove(slug);
      return reply.code(204).send();
    });

    scope.patch('/api/admin/decks/:slug', async (req, reply) => {
      const { title, viewerNav, aspect } = req.body ?? {};
      try {
        const meta = await decks.updateSettings(req.params.slug, { title, viewerNav, aspect });
        if (viewerNav !== undefined) live.setViewerNav(req.params.slug, meta.viewerNav);
        return { title: meta.title ?? null, viewerNav: meta.viewerNav, aspect: meta.aspect };
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // Opens or closes a room (`only` closes every other one) and sets its
    // limits (D1, D3 of 0003).
    scope.patch('/api/admin/rooms/:slug', async (req, reply) => {
      const { slug } = req.params;
      if (!(await decks.exists(slug))) return reply.code(404).send({ error: 'not-found' });
      const { patch, error } = parseRoomPatch(req.body);
      if (error) return reply.code(400).send({ error });
      if (decks.single && (patch.open === false || patch.only)) return reply.code(409).send({ error: 'single-deck' });
      const before = new Map((await decks.slugs()).map((x) => [x, rooms.settings(x)]));
      const room = await rooms.update(slug, patch);
      for (const [x, old] of before) live.roomUpdated(x, old);
      return room;
    });

    scope.put('/api/admin/decks/:slug/slides/:slideId', async (req, reply) => {
      const { slug, slideId } = req.params;
      const { notes, steps } = req.body ?? {};
      try {
        const meta = await decks.updateSlide(slug, slideId, { notes, steps });
        live.notifyNotes(slug, meta.slides);
        return { slide: meta.slides[slideId] };
      } catch (err) {
        return sendError(reply, err);
      }
    });

    scope.get('/api/admin/settings', async () => ({
      publicListing: config.publicListing,
      appearance: config.appearance,
      hasAdminPassword: Boolean(config.adminHash),
      hasPresenterPassword: Boolean(config.presenterHash),
      single: Boolean(decks.single),
    }));

    scope.put('/api/admin/settings', async (req, reply) => {
      const { publicListing, appearance } = req.body ?? {};
      if (publicListing !== undefined && typeof publicListing !== 'boolean') {
        return reply.code(400).send({ error: 'bad-request' });
      }
      const look = appearance === undefined ? {} : parseAppearance(appearance);
      if (!look) return reply.code(400).send({ error: 'bad-request' });
      if (publicListing !== undefined) config.publicListing = publicListing;
      config.appearance = { ...config.appearance, ...look };
      await saveConfig(ctx.stateDir, config);
      return { publicListing: config.publicListing, appearance: config.appearance };
    });

    scope.put('/api/admin/passwords', async (req, reply) => {
      const { scope: kind, deck, password } = req.body ?? {};
      if (!PASSWORD_SCOPES.has(kind)) return reply.code(400).send({ error: 'bad-request' });
      const perDeck = kind === 'deckPresenter' || kind === 'deckViewer';
      if (perDeck && !(isValidSlug(deck) && (await decks.exists(deck)))) {
        return reply.code(400).send({ error: 'no-deck' });
      }
      if (password === null) {
        if (kind === 'admin') return reply.code(400).send({ error: 'cannot-clear-admin' });
      } else {
        const problem = checkPasswordInput(password);
        if (problem) return reply.code(400).send({ error: problem });
      }
      await auth.setPassword(kind, perDeck ? deck : null, password);
      // The change revoked every admin session, including this one: keep the
      // person who made it signed in, on a fresh session id.
      if (kind === 'admin') await auth.grant(req, reply, { admin: true });
      return reply.code(204).send();
    });
  });
}
