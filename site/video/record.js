// Records the demo video for the website: npm run site:video
// Starts a real slidecast server with the deck in site/video/deck, films
// stage.html (presenter, projector and phone side by side) with Playwright and
// writes site/media/demo.webm and its poster, site/media/demo-poster.png.
import { copyFile, cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { buildServer } from '../../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const media = join(repo, 'site', 'media');
const size = { width: 1600, height: 900 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await mkdtemp(join(tmpdir(), 'slidecast-video-'));
const dataDir = join(root, 'decks');
await mkdir(dataDir);
await cp(join(here, 'deck'), join(dataDir, 'planets'), { recursive: true });
const stage = await readFile(join(here, 'stage.html'), 'utf8');
const logo = await readFile(join(repo, 'public', 'logo.svg'));

const app = await buildServer({
  dataDir,
  stateDir: join(root, 'state'),
  extraRoutes: async (a) => {
    a.get('/__stage', (req, reply) => reply.type('text/html; charset=utf-8').send(stage));
    a.get('/__stage/logo.svg', (req, reply) => reply.type('image/svg+xml').send(logo));
  },
});
await app.listen({ host: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: size,
  locale: 'en-US',
  recordVideo: { dir: join(root, 'video'), size },
});
await mkdir(media, { recursive: true });
const page = await context.newPage();
const video = page.video();

try {
  await page.goto(`${url}/__stage?deck=planets`);
  const deckIn = (id) => page.frameLocator(`#${id}`).frameLocator('iframe').first();
  for (const id of ['presenter', 'projector', 'audience']) {
    await deckIn(id).locator('#intro.active').waitFor();
  }
  await page.locator('#presenter').focus();

  const press = async (key, label) => {
    await page.evaluate((l) => window.showKey(l), label);
    await page.keyboard.press(key);
  };
  const say = (text) => page.evaluate((t) => window.say(t), text);

  await wait(800);
  await say('Present any HTML deck like in PowerPoint.');
  await wait(3000);
  await say('Notes, next slide and timer on your laptop…');
  await wait(3000);
  await say('…and every other screen follows you live.');
  await wait(1800);
  await press('ArrowRight', '→');
  await wait(1800);
  await press('ArrowRight', '→');
  await wait(1300);
  await press('ArrowRight', '→');
  await wait(2200);
  await page.screenshot({ path: join(media, 'demo-poster.png') });

  await press('ArrowRight', '→');
  await deckIn('audience').locator('#try.active').waitFor();
  await say('Interactive slides: everyone can play on their own screen.');
  await wait(1200);
  await deckIn('audience').locator('#au').evaluate((input) => new Promise((done) => {
    const start = performance.now();
    (function move(now) {
      const t = Math.min(1, (now - start) / 3500);
      input.value = String(1 + t * t * 29);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (t < 1) requestAnimationFrame(move); else done();
    })(start);
  }));
  await wait(2000);

  await press('ArrowRight', '→');
  await say('Reveal answers step by step.');
  await wait(2200);
  await press('ArrowRight', '→');
  await wait(2200);

  await say('Press B to black out every screen.');
  await wait(900);
  await press('b', 'B');
  await wait(2000);
  await press('b', 'B');
  await wait(1500);

  await press('ArrowRight', '→');
  await say('Runs on your own computer or server. No cloud, no account.');
  await wait(3200);
  await page.evaluate(() => window.theEnd());
  await wait(3200);
} finally {
  await context.close();
  await browser.close();
  await app.close();
}

await copyFile(await video.path(), join(media, 'demo.webm'));
await rm(root, { recursive: true, force: true });
console.log('Wrote site/media/demo.webm and site/media/demo-poster.png');
