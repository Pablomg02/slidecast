import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './server.js';

// No passwords: the loopback browser is local direct, so it may administer
// and present (D10).
let srv;
test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(async () => srv?.close());

const deckJson = async () => JSON.parse(await readFile(join(srv.dataDir, 'demo', 'deck.json'), 'utf8'));

test('write a slide note and a step note; saved to deck.json and pushed to the presenter', async ({ page, browser }) => {
  const presenterCtx = await browser.newContext();
  const presenter = await presenterCtx.newPage();
  await presenter.goto(`${srv.url}/demo/present`);
  await expect(presenter.locator('#counter')).toHaveText('1 / 7');
  await presenter.click('#next');
  await presenter.click('#next');
  await expect(presenter.locator('#counter')).toHaveText('3 / 7'); // how · step 1

  await page.goto(`${srv.url}/admin/edit/demo`);
  await expect(page.locator('#counter')).toHaveText('1 / 7');
  await page.click('.e-step[data-index="2"]');
  await expect(page.locator('#counter')).toHaveText('3 / 7');
  await expect(page.locator('label[for=slide-notes]')).toHaveText('Slide notes (how)');
  await expect(page.locator('label[for=step-note]')).toHaveText('Note for step 1');

  await page.fill('#slide-notes', 'Edited **slide** note');
  await page.fill('#step-note', 'Edited step note');
  await expect(page.locator('#preview strong')).toHaveText('slide');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });

  const meta = await deckJson();
  expect(meta.slides.how.notes).toBe('Edited **slide** note');
  expect(meta.slides.how.steps['1']).toBe('Edited step note');
  expect(meta.slides.how.steps['2']).toBe('Open a second tab as a viewer to see the sync.');
  expect(meta.title).toBe('syncdeck demo');

  await expect(presenter.locator('#notes')).toContainText('Edited slide note');
  await expect(presenter.locator('.p-note-step')).toHaveText('Edited step note');
  await presenterCtx.close();
});

test('arrow keys edit text inside the textareas and navigate outside them', async ({ page }) => {
  const before = srv.app.syncdeck.live.getState('demo')?.index ?? 0;
  await page.goto(`${srv.url}/admin/edit/demo`);
  await expect(page.locator('#counter')).toHaveText('1 / 7');
  await page.click('#slide-notes');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('PageDown');
  await expect(page.locator('#counter')).toHaveText('1 / 7');
  await page.locator('#slide-notes').blur();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#counter')).toHaveText('2 / 7');
  // The live presentation is not touched by the editor.
  await page.waitForTimeout(200);
  expect(srv.app.syncdeck.live.getState('demo')?.index ?? 0).toBe(before);
});

test('Ctrl+S saves immediately', async ({ page }) => {
  await page.goto(`${srv.url}/admin/edit/demo`);
  await expect(page.locator('#counter')).toHaveText('1 / 7');
  await page.fill('#slide-notes', 'Saved with the keyboard');
  await page.keyboard.press('Control+s');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect((await deckJson()).slides.intro.notes).toBe('Saved with the keyboard');
});
