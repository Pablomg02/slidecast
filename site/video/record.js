// Records the demo video for the website: npm run site:video
// Starts a real slidecast server with the deck in site/video/deck (plus a few
// copies under other names, so the admin panel has a list), films stage.html
// with Playwright and writes site/media/demo.webm, site/media/demo.mp4 (the
// copy Safari and iPhones play) and the poster, site/media/demo-poster.png.
// Needs an ffmpeg with libx264 and libvpx-vp9 on the PATH (set FFMPEG to use
// another binary) to cut and encode the film; without it only the raw
// recording is kept.
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { buildServer } from '../../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const media = join(repo, 'site', 'media');
const size = { width: 1600, height: 900 };
const LENGTH = 47; // seconds
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await mkdtemp(join(tmpdir(), 'slidecast-video-'));
const dataDir = join(root, 'decks');
await mkdir(dataDir);
await cp(join(here, 'deck'), join(dataDir, 'sound'), { recursive: true });
for (const [slug, title] of [['python-101', 'Intro to Python'], ['q3-review', 'Quarterly review'], ['launch', 'Product launch']]) {
  await mkdir(join(dataDir, slug));
  await copyFile(join(here, 'deck', 'index.html'), join(dataDir, slug, 'index.html'));
  await writeFile(join(dataDir, slug, 'deck.json'), JSON.stringify({ slidecast: 1, title }));
}
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
// The admin pages refuse to be framed; only this film lifts that, to show them
// inside the stage.
await context.route(/\/admin(\/|$)/, async (route) => {
  if (route.request().resourceType() !== 'document') return route.continue();
  const response = await route.fetch();
  const headers = { ...response.headers() };
  delete headers['x-frame-options'];
  if (headers['content-security-policy']) {
    headers['content-security-policy'] = headers['content-security-policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'");
  }
  await route.fulfill({ response, headers });
});
await mkdir(media, { recursive: true });
const page = await context.newPage();
const filmStart = Date.now();
const video = page.video();
let showStart;

try {
  await page.goto(`${url}/__stage?deck=sound`);
  const frame = (id) => page.frameLocator(`#${id}`);
  const deckIn = (id) => frame(id).frameLocator('iframe').first();
  for (const id of ['presenter', 'projector', 'audience', 'remote', 'remoteView', 'backView', 'blankView', 'blankPhone1', 'blankPhone2', 'editor']) {
    await deckIn(id).locator('#intro.active').waitFor({ state: 'attached' });
  }
  await frame('raw').locator('#intro.active').waitFor({ state: 'attached' });
  await frame('admin').locator('table.deck-table').waitFor({ state: 'attached' });
  await wait(1500);

  const cue = (name, arg) => page.evaluate(([n, a]) => window.cue[n](a), [name, arg]);
  const click = (id, selector) => frame(id).locator(selector).evaluate((b) => b.click());
  // Keys go straight to the page in that frame: the stage holds many frames
  // and keyboard focus between them is not reliable in a headless browser.
  const press = (id, key) => frame(id).locator('body').evaluate((b, k) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  }, key);
  // Every beat is placed on an absolute clock, so slow steps never add up.
  showStart = Date.now();
  const at = (s) => wait(Math.max(0, showStart + s * 1000 - Date.now()));

  // 1. The problem.
  await cue('problem');
  await at(2.4); await cue('gorgeous');
  await at(4.8); await cue('present');
  for (let i = 0; i < 4; i++) { await at(5.5 + i * 0.45); await cue('missing', i); }

  // 2. slidecast.
  await at(9.0); await cue('intro');

  // 3. A class: laptop, projector and a phone in the audience.
  await at(12.0); await cue('classroom');
  await at(12.3); await cue('say', 'Notes, next slide and timer *on your laptop.*');
  await click('presenter', '#timer-toggle');
  await at(13.0); await cue('zoomLaptop');
  await at(16.0); await cue('camera'); await cue('say', 'Every other screen *follows you live.*');
  for (const t of [16.9, 17.8, 18.7]) {
    await at(t); await cue('key', '→'); await press('presenter', 'ArrowRight');
  }
  await at(19.3); await page.screenshot({ path: join(media, 'demo-poster.png') });
  await at(19.8); await cue('key', '→'); await press('presenter', 'ArrowRight');
  await cue('say', 'Interactive slides: *everyone plays along.*');
  await at(20.3); await cue('zoomPhone');
  await at(21.1);
  await deckIn('audience').locator('#freq').evaluate((input) => new Promise((done) => {
    const start = performance.now();
    (function move(now) {
      const t = Math.min(1, (now - start) / 3200);
      input.value = String(333 + (0.5 - Math.cos(t * Math.PI) / 2) * 560);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (t < 1) requestAnimationFrame(move); else done();
    })(start);
  }));

  // 4. Everything else, on the real pages.
  await at(25.0); await cue('more');
  await at(26.6); await cue('tile', 0);
  await at(28.6); await cue('tile', 1);
  await at(29.1);
  const notes = frame('editor').locator('#slide-notes');
  await notes.fill('');
  await notes.pressSequentially('Play a violin and a flute on **the same note**.', { delay: 30 });
  await at(30.9); await cue('tile', 2);
  await at(31.6); await cue('remoteArrow'); await click('remote', '#next');
  await at(32.4); await cue('remoteArrow'); await click('remote', '#next');
  await at(33.1); await cue('tile', 3);
  await at(33.7); await press('backView', 'ArrowLeft');
  await at(34.2); await press('backView', 'ArrowLeft');
  await at(34.9); await click('backView', '.back-to-live');
  await at(35.4); await cue('tile', 4);
  await at(36.0); await cue('key2', 'B'); await press('presenter', 'b');
  await at(37.0); await cue('key2', 'B'); await press('presenter', 'b');
  await at(37.6); await cue('tile', 5); await cue('terminal');
  await at(39.7); await cue('grid');

  // 5. Where to get it.
  await at(42.9); await cue('cta');
  await at(LENGTH);
} finally {
  await context.close();
  await browser.close();
  await app.close();
}

const raw = join(root, 'raw.webm');
await copyFile(await video.path(), raw);
const ffmpeg = (args) => spawnSync(process.env.FFMPEG ?? 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-ss', String((showStart - filmStart) / 1000), '-t', String(LENGTH), '-i', raw, '-an', ...args,
], { stdio: 'inherit' });
const webm = ffmpeg(['-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', join(media, 'demo.webm')]);
const mp4 = webm.status === 0 && ffmpeg([
  '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
  '-preset', 'slow', '-crf', '27', '-movflags', '+faststart', join(media, 'demo.mp4'),
]);
if (mp4?.status === 0) {
  console.log('Wrote site/media/demo.webm, demo.mp4 and demo-poster.png');
} else {
  await copyFile(raw, join(media, 'demo.webm'));
  console.warn('Could not encode the film: install ffmpeg with libx264 and libvpx-vp9, or set FFMPEG, and run this again.');
  console.warn('Wrote the raw, uncut recording to site/media/demo.webm.');
}
await rm(root, { recursive: true, force: true });
