import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { loadConfig } from './config.js';
import { readJson } from './store.js';
import { createDeckStore } from './decks.js';
import { registerDeckFiles } from './deckfiles.js';
import { registerSecurity } from './security.js';
import { createAuth, registerAuthRoutes } from './auth.js';
import { createLive, registerLive, MAX_MESSAGE } from './live.js';
import { PUBLIC_DIR } from './paths.js';
import { registerPages } from './routes/pages.js';
import { registerApi } from './routes/api.js';
import { registerAdmin } from './routes/admin.js';

export { PUBLIC_DIR };

const require = createRequire(import.meta.url);
const markdownIt = readFileSync(join(require.resolve('markdown-it/package.json'), '..', 'dist', 'markdown-it.min.js'));

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
    decks: createDeckStore({
      dataDir: o.dataDir,
      stateDir,
      singleDeck: o.singleDeck,
      log: (msg) => app.log.warn(msg),
    }),
  };
  ctx.auth = await createAuth(ctx);
  ctx.live = await createLive(ctx, { heartbeatMs: o.heartbeatMs });
  app.decorate('slidecast', ctx);

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
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

  // `slidecast passwd` edits config.json while the server may be running.
  const configPath = join(stateDir, 'config.json');
  watchFile(configPath, { interval: 2000, persistent: false }, async (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    try {
      const fresh = await readJson(configPath, null);
      if (fresh) await ctx.auth.onConfigFileChanged(fresh);
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
