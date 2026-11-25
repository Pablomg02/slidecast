import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { loadConfig, saveConfig, isOwnConfigWrite } from './config.js';
import { readJson } from './store.js';
import { createDeckStore } from './decks.js';
import { registerDeckFiles } from './deckfiles.js';
import { registerSecurity } from './security.js';
import { createAuth, registerAuthRoutes, shownPassword } from './auth.js';
import { createLive, registerLive, MAX_MESSAGE } from './live.js';
import { createRooms } from './rooms.js';
import { PUBLIC_DIR } from './paths.js';
import { registerPages } from './routes/pages.js';
import { registerApi } from './routes/api.js';
import { registerAdmin } from './routes/admin.js';

export { PUBLIC_DIR };

const require = createRequire(import.meta.url);
// The UMD build: loaded as a classic script, it defines window.markdownit.
const markdownIt = readFileSync(require.resolve('markdown-it/browser'));

export async function buildServer(opts = {}) {
  const o = {
    dataDir: './decks',
    stateDir: './.slidecast',
    singleDeck: null,
    trustProxy: false,
    logger: false,
    extraRoutes: null,
    ...opts,
  };
  const app = Fastify({ logger: o.logger });
  const stateDir = resolve(o.stateDir);
  const config = await loadConfig(stateDir);
  const ctx = {
    config,
    stateDir,
    trustProxy: Boolean(o.trustProxy),
    loginLimits: o.loginLimits,
    wsLimits: o.wsLimits,
    joinLimit: o.joinLimit,
    decks: createDeckStore({
      dataDir: o.dataDir,
      stateDir,
      singleDeck: o.singleDeck,
      log: (msg) => app.log.warn(msg),
    }),
  };
  // Where the server listens (null before listen): the join screen's last
  // resort for an address (D3 of 0011).
  ctx.listenAddress = () => {
    const a = app.server.address();
    return a && typeof a === 'object' ? a : null;
  };
  ctx.auth = await createAuth(ctx);
  ctx.rooms = createRooms(ctx);
  ctx.live = await createLive(ctx, { heartbeatMs: o.heartbeatMs, graceMs: o.graceMs, now: o.now });
  app.decorate('slidecast', ctx);

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_MESSAGE } });
  registerSecurity(app);

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/_slidecast/', index: false });
  registerDeckFiles(app, ctx);
  registerAuthRoutes(app, ctx);
  registerLive(app, ctx);
  registerApi(app, ctx);
  app.get('/_slidecast/vendor/markdown-it.min.js', (req, reply) => reply
    .type('text/javascript; charset=utf-8')
    .header('Cache-Control', 'public, max-age=86400')
    .send(markdownIt));
  registerAdmin(app, ctx);
  registerPages(app, ctx);

  // `slidecast passwd` edits config.json while the server may be running. The
  // poll sees the server's own writes too, maybe an older one after a newer
  // change in memory: those are skipped (see isOwnConfigWrite).
  const configPath = join(stateDir, 'config.json');
  ctx.configFileChanged = async (fresh) => {
    if (!fresh || isOwnConfigWrite(configPath, fresh)) return;
    await ctx.auth.onConfigFileChanged(fresh);
    ctx.live.shareChanged(); // a viewer password the join screen shows (0011)
    // A clear copy this server does not keep (its room stopped showing the
    // password while the CLI wrote) must not stay on disk (D6 of 0011).
    const stale = Object.entries(fresh.decks ?? {})
      .some(([slug, d]) => typeof d?.viewerClear === 'string' && d.viewerClear !== shownPassword(config, slug));
    if (stale) await saveConfig(stateDir, config);
  };
  watchFile(configPath, { interval: 2000, persistent: false }, async (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    try {
      await ctx.configFileChanged(await readJson(configPath, null));
    } catch (err) {
      app.log.warn(`could not reload config.json: ${err.message}`);
    }
  });

  app.addHook('onClose', async () => {
    unwatchFile(configPath);
    await ctx.live.close();
    await ctx.auth.close();
  });

  // Only tests set extraRoutes, to mount fixtures; the CLI never does.
  if (o.extraRoutes) await o.extraRoutes(app);
  return app;
}
