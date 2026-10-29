import { DeckError, isValidSlug, normalizeMeta } from '../decks.js';
import { zipStream } from '../zipwrite.js';
import { parseSteps } from '../notes.js';
import { issueDeckToken } from '../tokens.js';
import { saveConfig } from '../config.js';
import { checkPasswordInput } from '../auth.js';
import { sendPage } from './pages.js';
import { parseAppearance } from '../appearance.js';
import { parseRoomPatch } from '../rooms.js';

const UPLOAD_LIMIT = 100 * 1024 * 1024;
// The zip writer has no zip64 (D14 of 0004).
const ZIP_MAX_FILES = 65_535;
const ZIP_MAX_BYTES = 4_000_000_000;
const PASSWORD_SCOPES = new Set(['admin', 'presenter', 'deckPresenter', 'deckViewer']);

const ERRORS = {
  ERR_BAD_SLUG: [400, 'bad-slug'],
  ERR_BAD_INPUT: [400, 'bad-request'],
  ERR_ZIP: [400, 'bad-zip'],
  ERR_NO_INDEX: [400, 'no-index'],
  ERR_NOT_FOUND: [404, 'not-found'],
  ERR_SINGLE_DECK: [409, 'single-deck'],
  ERR_BAD_META: [409, 'bad-deck-json'],
  ERR_CONFLICT: [409, 'deck-changed'],
  ERR_STAGE_GONE: [404, 'stage-gone'],
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

    const uploadKind = (req) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      return type === 'application/zip' ? 'zip' : 'html';
    };
    const hasBody = (req) => Buffer.isBuffer(req.body) && req.body.length > 0;

    scope.post('/api/admin/decks', async (req, reply) => {
      if (!hasBody(req)) return reply.code(400).send({ error: 'empty-body' });
      try {
        const result = await decks.upload(String(req.query.slug ?? ''), req.body, uploadKind(req));
        live.resetDeck(result.slug);
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    });

    // The deck with its notes, as a zip that uploads back as is. This is the
    // only way to read deck.json over HTTP.
    scope.get('/api/admin/decks/:slug/download', async (req, reply) => {
      const { slug } = req.params;
      let files;
      let version;
      try {
        files = await decks.files(slug);
        version = await decks.version(slug);
      } catch (err) {
        return sendError(reply, err);
      }
      const entries = files.map((f) => ({ path: f.path, mtime: f.mtime, file: f.file }));
      if (!files.some((f) => f.path === 'deck.json')) {
        entries.push({ path: 'deck.json', mtime: new Date(), data: Buffer.from(`${JSON.stringify(normalizeMeta({}), null, 2)}\n`) });
      }
      const bytes = files.reduce((n, f) => n + f.size, 0);
      if (entries.length > ZIP_MAX_FILES || bytes > ZIP_MAX_BYTES) return reply.code(413).send({ error: 'too-big' });
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="${slug}.zip"`)
        .send(zipStream(entries, {
          // An update or upload during a slow download: fail rather than
          // deliver a zip mixing the old and new versions.
          check: async () => {
            if (await decks.version(slug).catch(() => null) !== version) throw new Error(`deck ${slug} changed during the download`);
          },
        }));
    });

    // Update in two phases (0004): stage the new version, let the browser
    // report its slides and show what happens to the notes, then commit.
    scope.post('/api/admin/decks/:slug/stage', async (req, reply) => {
      const { slug } = req.params;
      if (!hasBody(req)) return reply.code(400).send({ error: 'empty-body' });
      try {
        const st = await decks.stage(slug, req.body, uploadKind(req));
        const token = issueDeckToken(config.secret, `stage:${st.id}`);
        return reply.code(201).send({
          id: st.id,
          deckUrl: `/_stage/${st.id}/${token}/`,
          hasIncoming: st.hasIncoming,
          incomingInvalid: st.incomingInvalid,
          same: st.same,
          live: live.counts(slug),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    });

    scope.post('/api/admin/stages/:id/diff', async (req, reply) => {
      try {
        return await decks.stageSummary(req.params.id, parseSteps(req.body?.steps ?? null));
      } catch (err) {
        return sendError(reply, err);
      }
    });

    scope.post('/api/admin/stages/:id/commit', async (req, reply) => {
      const { notes, steps } = req.body ?? {};
      try {
        const r = await decks.commitStage(req.params.id, { notes, steps: parseSteps(steps ?? null) });
        live.resetDeck(r.slug);
        live.setViewerNav(r.slug, r.meta.viewerNav);
        live.notifyNotes(r.slug, r.meta.slides);
        return { slug: r.slug, removedSlides: r.removedSlides, removedSteps: r.removedSteps };
      } catch (err) {
        return sendError(reply, err);
      }
    });

    scope.delete('/api/admin/stages/:id', async (req, reply) => {
      await decks.discardStage(req.params.id);
      return reply.code(204).send();
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

    // Opens, hides or closes a room and sets its limits (D1, D3 of 0003).
    scope.patch('/api/admin/rooms/:slug', async (req, reply) => {
      const { slug } = req.params;
      if (!(await decks.exists(slug))) return reply.code(404).send({ error: 'not-found' });
      const { patch, error } = parseRoomPatch(req.body);
      if (error) return reply.code(400).send({ error });
      if (decks.single && patch.open === false) return reply.code(409).send({ error: 'single-deck' });
      const before = rooms.settings(slug);
      const room = await rooms.update(slug, patch);
      live.roomUpdated(slug, before);
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
