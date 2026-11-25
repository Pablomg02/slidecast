import { test, expect } from '@playwright/test';
import jsQR from 'jsqr';
import { startServer } from './server.js';

// The join screen (0011): the presenter, on a computer or a phone, puts a QR
// code, the address and the viewer password on every screen.
// Passwords set, so a browser without a session is a plain participant; the
// admin's cookie gives presenter and admin rights.
const SHOTS = process.env.SHARE_SHOTS; // a folder to save screenshots in, to look at them
let srv;
let adminCookie;
test.beforeAll(async () => {
  srv = await startServer({
    passwords: { presenter: 'presenter-pass1', admin: 'admin-password1', 'deckViewer:demo': 'class-pass1' },
  });
  adminCookie = await srv.login('admin', 'admin-password1');
});
test.afterAll(async () => srv?.close());

let contexts = [];
test.afterEach(async () => {
  for (const c of contexts) await c.close();
  contexts = [];
});

async function open(browser, path, { cookie = adminCookie, ...opts } = {}) {
  const context = await browser.newContext(opts);
  contexts.push(context);
  if (cookie) await context.addCookies([{ name: 'sc_session', value: cookie, url: srv.url }]);
  const page = await context.newPage();
  await page.goto(`${srv.url}${path}`);
  return page;
}

// Reads the QR code as the projector draws it: the SVG, rasterised in the page.
async function readQr(page) {
  const { width, data } = await page.locator('#share-qr svg').evaluate(async (svg) => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(svg))}`;
    await img.decode();
    const size = 400;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, size, size);
    return { width: size, data: [...g.getImageData(0, 0, size, size).data] };
  });
  return jsQR(Uint8ClampedArray.from(data), width, width)?.data ?? null;
}

const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);

test('presenter on a computer: QR, address and password on every screen, never for the audience', async ({ browser }) => {
  // The admin turns the password on and types it once.
  const admin = await open(browser, '/admin');
  await admin.click('tr[data-slug=demo] button:has-text("Settings")');
  await expect(admin.locator('#show-password-confirm')).toBeHidden();
  await admin.check('#room-show-password');
  await expect(admin.locator('#show-password-confirm')).toBeVisible();
  await admin.fill('#show-password-input', 'wrong-pass1');
  await admin.click('#show-password-go');
  await expect(admin.locator('#show-password-confirm .status.error')).toHaveText('Wrong password.');
  await admin.fill('#show-password-input', 'class-pass1');
  await admin.click('#show-password-go');
  await expect(admin.locator('#show-password-state')).toHaveText('The join screen shows it.');
  await expect(admin.locator('#show-password-confirm')).toBeHidden();
  await admin.click('.deck-settings button:has-text("Close")');

  const projector = await open(browser, '/demo/view', { viewport: { width: 1280, height: 720 } });
  const second = await open(browser, '/demo/view?control=off', { viewport: { width: 1024, height: 768 } });
  const viewerCookie = await srv.login('viewer', 'class-pass1', 'demo');
  const audience = await open(browser, '/demo/view', { cookie: viewerCookie });
  const presenter = await open(browser, '/demo/present', { viewport: { width: 1400, height: 900 } });
  await expect(presenter.locator('#counter')).toHaveText(/^1 \//);

  // No address yet: the server only listens on this computer.
  await presenter.click('#share-toggle');
  await expect(presenter.locator('#share-strip')).toBeVisible();
  await expect(presenter.locator('#share-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(projector.locator('#share')).toBeVisible();
  await expect(projector.locator('#share-none')).toBeVisible();
  await expect(projector.locator('#share-qr')).toBeHidden();

  // The admin sets the address the audience comes in by.
  await admin.reload();
  await admin.fill('#audience-url', 'slides.example.org');
  await admin.click('#audience-save');
  await expect(admin.locator('.audience-url .status.error')).toContainText('https://');
  await admin.fill('#audience-url', 'https://slides.example.org/');
  await admin.click('#audience-save');
  await expect(admin.locator('.audience-url .status.ok')).toHaveText('Saved');
  await expect(admin.locator('#audience-url')).toHaveValue('https://slides.example.org');

  for (const screen of [projector, second]) {
    await expect(screen.locator('#share-url')).toHaveText('slides.example.org/demo');
    await expect(screen.locator('#share-password')).toHaveText('class-pass1');
    await expect(screen.locator('#share-none')).toBeHidden();
    expect(await readQr(screen)).toBe('https://slides.example.org/demo/view');
  }
  await shot(projector, 'projector-1280x720');
  await second.setViewportSize({ width: 720, height: 1280 });
  await shot(second, 'projector-portrait');
  await shot(presenter, 'presenter-desktop');
  await expect(audience.locator('#share')).toHaveCount(0);

  // Blanking hides it on the screens; the next slide takes it off.
  await presenter.keyboard.press('b');
  await expect(projector.locator('#share')).toBeHidden();
  await expect(presenter.locator('#blanked')).toBeVisible();
  await presenter.keyboard.press('b');
  await expect(projector.locator('#share')).toBeVisible();
  await presenter.click('#next');
  await expect(projector.locator('#share')).toBeHidden();
  await expect(second.locator('#share')).toBeHidden();
  await expect(presenter.locator('#share-strip')).toBeHidden();
  await expect(presenter.locator('#share-toggle')).toHaveAttribute('aria-pressed', 'false');

  // The password off in the admin panel: the screens ask people to ask for it.
  await admin.click('tr[data-slug=demo] button:has-text("Settings")');
  await admin.uncheck('#room-show-password');
  await expect(admin.locator('.show-password .status.ok')).toHaveText('Saved');
  await presenter.click('#share-toggle');
  await expect(projector.locator('#share-ask')).toBeVisible();
  await expect(projector.locator('#share-password')).toBeHidden();
  await presenter.click('#share-off');
  await expect(projector.locator('#share')).toBeHidden();
});

test('presenter on a phone shows it from "More" and takes it off from the strip', async ({ browser }) => {
  await srv.app.slidecast.rooms.update('demo', { showPassword: true });
  const projector = await open(browser, '/demo/view?control=off', { viewport: { width: 1280, height: 720 } });
  const phone = await open(browser, '/demo/present', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await expect(phone.locator('#counter')).toHaveText(/\//);
  await expect(phone.locator('#share-toggle')).toBeHidden();
  await phone.click('#more');
  await phone.click('#share-toggle');
  await expect(projector.locator('#share')).toBeVisible();
  // Turned on again without the password typed: the presenter is told.
  await expect(phone.locator('#share-note')).toContainText('the admin has to type it');
  await expect(projector.locator('#share-password')).toBeHidden();
  await phone.click('#more');
  await expect(phone.locator('#share-strip')).toBeVisible();
  await shot(phone, 'presenter-phone');
  await phone.click('#share-off');
  await expect(projector.locator('#share')).toBeHidden();
  await expect(phone.locator('#share-strip')).toBeHidden();
});
