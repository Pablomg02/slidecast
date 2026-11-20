// Records the demo video for the website: npm run site:video
// Starts a real slidecast server with the deck in site/video/deck (plus a few
// copies under other names, so the admin panel has a list), films stage.html
// with Playwright and writes site/media/demo.webm, site/media/demo.mp4 (the
// copy Safari and iPhones play) and the poster, site/media/demo-poster.png.
// The audience is real too: four phones in the stage and eight more people
// over WebSocket answer the deck's polls, so the contest has a top 10.
// Needs an ffmpeg with libx264 and libvpx-vp9 on the PATH (set FFMPEG to use
// another binary) to cut and encode the film; without it only the raw
// recording is kept.
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { buildServer } from '../../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const media = join(repo, 'site', 'media');
const size = { width: 1600, height: 900 };
const LENGTH = 56.2; // seconds
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
// The terminal in the film prints the version in package.json.
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const stage = (await readFile(join(here, 'stage.html'), 'utf8')).replace('__VERSION__', version);
const logo = await readFile(join(repo, 'public', 'logo.svg'));

const app = await buildServer({
  dataDir,
  stateDir: join(root, 'state'),
  extraRoutes: async (a) => {
    a.get('/__stage', (req, reply) => reply.type('text/html; charset=utf-8').send(stage));
    a.get('/__stage/logo.svg', (req, reply) => reply.type('image/svg+xml').send(logo));
  },
});
// Rooms start closed; the audience needs this one open.
await app.slidecast.rooms.update('sound', { open: true });
await app.listen({ host: '127.0.0.1', port: 0 });
const port = app.server.address().port;
const url = `http://127.0.0.1:${port}`;

// Someone in the audience without a browser, to fill the ranking. Like the
// stage's phones, it reaches the server by a name of its own
// (<name>.localhost), so it is a participant, not a presenter's screen.
function person(name) {
  const host = `${name.normalize('NFD').replace(/[^a-z]/gi, '').toLowerCase()}.localhost:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sound?role=viewer`, { headers: { Host: host, Origin: `http://${host}` } });
  let poll = null;
  let named = false;
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.t === 'poll') poll = m.poll;
    if (m.t === 'you' && !named) { named = true; ws.send(JSON.stringify({ t: 'name', name })); }
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', token: null })));
  ws.on('error', (err) => console.warn(`${name}: ${err.message}`));
  return {
    vote(choice) {
      if (poll?.open) ws.send(JSON.stringify({ t: 'vote', id: poll.id, choice }));
      else console.warn(`${name}: no open poll to answer`);
    },
    close: () => ws.close(),
  };
}

// *.localhost is this machine. The stage frames the phones' pages from
// 127.0.0.1 (the route below lets it), and Chromium counts a page the route
// handed over as from the internet, so it would block its calls to this
// machine without the second flag.
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--disable-features=LocalNetworkAccessChecks'] });
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
await context.route(/^http:\/\/[a-z]+\.localhost:\d+\//, async (route) => {
  if (route.request().resourceType() !== 'document') return route.continue();
  const response = await route.fetch();
  const headers = { ...response.headers() };
  if (headers['content-security-policy']) {
    headers['content-security-policy'] = headers['content-security-policy'].replace("frame-ancestors 'self'", `frame-ancestors 'self' ${url}`);
  }
  await route.fulfill({ response, headers });
});
await mkdir(media, { recursive: true });
const page = await context.newPage();
const filmStart = Date.now();
const video = page.video();
let showStart;
const crowd = [];

try {
  await page.goto(`${url}/__stage?deck=sound`);
  const frame = (id) => page.frameLocator(`#${id}`);
  const deckIn = (id) => frame(id).frameLocator('iframe').first();
  for (const id of ['presenter', 'projector', 'audience', 'remote', 'remoteView', 'backView', 'blankView', 'blankPhone1', 'blankPhone2', 'editor', 'presenter2', 'projector2']) {
    await deckIn(id).locator('#intro.active').waitFor({ state: 'attached' });
  }
  // Contest mode: each phone enters the room with a name.
  const phones = { phoneA: 'Ana', phoneB: 'Leo', phoneC: 'Maya', phoneD: 'Sam' };
  for (const [id, name] of Object.entries(phones)) {
    await frame(id).locator('#join-name').evaluate((input, n) => { input.value = n; }, name);
    await frame(id).locator('#join-enter').evaluate((b) => b.click());
    await frame(id).locator('.join-dialog').waitFor({ state: 'hidden' });
    await deckIn(id).locator('#intro.active').waitFor({ state: 'attached' });
  }
  for (const name of ['Noah', 'Zoe', 'Iker', 'Lucía', 'Omar', 'Eva', 'Tom', 'Priya']) crowd.push(person(name));
  await frame('raw').locator('#intro.active').waitFor({ state: 'attached' });
  await frame('admin').locator('table.deck-table').waitFor({ state: 'attached' });
  await frame('presenter2').locator('#timer-toggle').evaluate((b) => b.click());
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

  // A tap on a real page (a click, on the laptop), with a dot where it lands.
  const tap = async (id, selector) => {
    const target = frame(id).locator(selector).first();
    const point = await target.evaluate((el) => {
      el.scrollIntoView({ block: 'nearest' });
      const b = el.getBoundingClientRect();
      return [b.x + b.width / 2, b.y + b.height / 2];
    });
    await cue('tap', [id, ...point]);
    await wait(150);
    await target.evaluate((el) => el.click());
  };
  // Beats that overlap others: taps on the phones, the crowd's answers.
  const later = (s, fn) => setTimeout(() => fn().catch((err) => console.warn(err.message)), Math.max(0, showStart + s * 1000 - Date.now()));
  const launch = '#poll-launch:visible, .p-poll-slide [data-action=launch]:visible';

  // 1. The problem.
  await cue('problem');
  await at(2.0); await cue('gorgeous');
  await at(4.0); await cue('present');
  for (let i = 0; i < 4; i++) { await at(4.6 + i * 0.4); await cue('missing', i); }

  // 2. slidecast.
  await at(7.4); await cue('intro');

  // 3. A class: laptop, projector and a phone in the audience.
  await at(8.9); await cue('wake', 'class');
  await at(9.9); await cue('classroom');
  await at(10.2); await cue('say', 'Notes, next slide and timer *on your laptop.*');
  await click('presenter', '#timer-toggle');
  await at(10.7); await cue('zoomLaptop');
  await at(13.0); await cue('camera'); await cue('say', 'Every other screen *follows you live.*');
  for (const t of [13.7, 14.4, 15.1]) {
    await at(t); await cue('key', '→'); await press('presenter', 'ArrowRight');
  }
  await at(15.8); await cue('key', '→'); await press('presenter', 'ArrowRight');
  await cue('say', 'Interactive slides: *everyone plays along.*');
  await at(16.2); await cue('zoomPhone');
  await at(17.0);
  await deckIn('audience').locator('#freq').evaluate((input) => new Promise((done) => {
    const start = performance.now();
    (function move(now) {
      const t = Math.min(1, (now - start) / 2600);
      input.value = String(333 + (0.5 - Math.cos(t * Math.PI) / 2) * 560);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (t < 1) requestAnimationFrame(move); else done();
    })(start);
  }));

  // 4. The audience takes part: a poll, then a question of the contest.
  const P = 20.0;
  await at(P - 1.0); await cue('wake', 'poll');
  await at(P); await cue('poll'); await cue('say2', 'Ask the room: *every phone gets the question.*');
  await at(P + 0.5); await press('presenter2', 'ArrowRight');
  await at(P + 1.3); await tap('presenter2', launch);
  await at(P + 2.0); await cue('zoomPhones');
  // Piccolo (3) is right; one tap chooses, another sends.
  [[2.0, 3], [2.4, 3], [2.7, 2], [3.1, 3], [3.4, 3], [3.8, 0], [4.1, 3], [4.4, 3]].forEach(([t, c], i) => later(P + t, async () => crowd[i].vote([c])));
  [['phoneA', 3, 2.9], ['phoneB', 2, 3.2], ['phoneC', 3, 3.5], ['phoneD', 3, 3.8]].forEach(([id, c, t]) => {
    later(P + t, () => tap(id, `label[for=poll-answer-${c}]`));
    later(P + t + 0.45, () => tap(id, '#poll-send'));
  });
  await at(P + 4.7); await cue('zoomLaptop2'); await cue('say2', 'Results stay secret *until you show them.*');
  await frame('presenter2').locator('.p-poll-shown .p-poll-actions').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await at(P + 6.3); await tap('presenter2', '.p-poll-shown [data-action=close-results]');
  await at(P + 6.8); await cue('wide');
  await at(P + 7.9); await page.screenshot({ path: join(media, 'demo-poster.png') });
  await at(P + 8.4); await cue('say2', 'Or make it a contest: *quick right answers score.*');
  await press('presenter2', 'ArrowRight');
  await at(P + 9.2); await tap('presenter2', launch);
  await at(P + 9.8); await cue('zoomPhones');
  // One tap answers. "Goes up an octave" (2) is right; Ana is the quickest.
  [['phoneA', 2, 11.0], ['phoneB', 2, 11.4], ['phoneC', 0, 11.8], ['phoneD', 2, 12.2]].forEach(([id, c, t]) => {
    later(P + t, () => tap(id, `label[for=poll-answer-${c}]`));
  });
  [[11.6, 2], [11.8, 2], [12.0, 2], [12.1, 1], [12.3, 2], [12.5, 2], [12.6, 2], [12.8, 2]].forEach(([t, c], i) => later(P + t, async () => crowd[i].vote([c])));
  // Everyone has answered: answers close by themselves.
  await at(P + 13.2); await cue('zoomOnePhone', 'phoneA'); await cue('say2', 'Points on every phone…');
  await at(P + 13.4); await click('presenter2', '.p-poll-shown .p-poll-actions [data-action=reveal]');
  await at(P + 15.4); await click('presenter2', '.p-poll-shown [data-action=show-ranking]');
  await cue('zoomWall'); await cue('say2', '…and the top 10 *on the projector.*');

  // 5. Everything else, on the real pages. Offstage, the presenter goes back
  // to the start of "mix" (which takes the ranking off the screens).
  const T = P + 18.2;
  await at(T - 1.0); await cue('wake', 'more');
  await at(T); await cue('more');
  await at(T + 0.5); await press('presenter', 'Home'); await press('presenter', 'ArrowRight');
  await at(T + 1.2); await cue('tile', 0);
  await at(T + 2.8); await cue('tile', 1);
  await at(T + 3.1);
  const notes = frame('editor').locator('#slide-notes');
  await notes.fill('');
  await notes.pressSequentially('Play a violin and a flute on **the same note**.', { delay: 20 });
  await at(T + 4.3); await cue('tile', 2);
  await at(T + 4.9); await cue('remoteArrow'); await click('remote', '#next');
  await at(T + 5.5); await cue('remoteArrow'); await click('remote', '#next');
  await at(T + 6.0); await cue('tile', 3);
  await at(T + 6.5); await press('backView', 'ArrowLeft');
  await at(T + 6.9); await press('backView', 'ArrowLeft');
  await at(T + 7.4); await click('backView', '.back-to-live');
  await at(T + 7.8); await cue('tile', 4);
  await at(T + 8.6); await cue('key2', 'B'); await press('presenter', 'b');
  await at(T + 9.4); await cue('key2', 'B'); await press('presenter', 'b');
  await at(T + 10.0); await cue('tile', 5); await cue('terminal');
  await at(T + 11.6); await cue('grid');

  // 6. Where to get it.
  await at(T + 14.2); await cue('cta');
  await at(LENGTH);
} finally {
  for (const p of crowd) p.close();
  await context.close();
  await browser.close();
  await app.close();
}

const raw = join(root, 'raw.webm');
await copyFile(await video.path(), raw);
const ffmpeg = (args) => spawnSync(process.env.FFMPEG ?? 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-ss', String((showStart - filmStart) / 1000), '-t', String(LENGTH), '-i', raw, '-an', ...args,
], { stdio: 'inherit' });
const webm = ffmpeg(['-c:v', 'libvpx-vp9', '-crf', '38', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', join(media, 'demo.webm')]);
const mp4 = webm.status === 0 && ffmpeg([
  '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
  '-preset', 'slow', '-crf', '29', '-movflags', '+faststart', join(media, 'demo.mp4'),
]);
if (mp4?.status === 0) {
  console.log('Wrote site/media/demo.webm, demo.mp4 and demo-poster.png');
} else {
  await copyFile(raw, join(media, 'demo.webm'));
  console.warn('Could not encode the film: install ffmpeg with libx264 and libvpx-vp9, or set FFMPEG, and run this again.');
  console.warn('Wrote the raw, uncut recording to site/media/demo.webm.');
}
await rm(root, { recursive: true, force: true });
