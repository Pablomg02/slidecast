import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
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
  expect(meta.title).toBe('slidecast demo');

  await expect(presenter.locator('#notes')).toContainText('Edited slide note');
  await expect(presenter.locator('.p-note-step')).toHaveText('Edited step note');
  await presenterCtx.close();
});

test('arrow keys edit text inside the textareas and navigate outside them', async ({ page }) => {
  const before = srv.app.slidecast.live.getState('demo')?.index ?? 0;
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
  expect(srv.app.slidecast.live.getState('demo')?.index ?? 0).toBe(before);
});

test('Ctrl+S saves immediately', async ({ page }) => {
  await page.goto(`${srv.url}/admin/edit/demo`);
  await expect(page.locator('#counter')).toHaveText('1 / 7');
  await page.fill('#slide-notes', 'Saved with the keyboard');
  await page.keyboard.press('Control+s');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect((await deckJson()).slides.intro.notes).toBe('Saved with the keyboard');
});

test('"Edit notes" in the presenter view opens the editor at the step being presented', async ({ page, context }) => {
  await page.goto(`${srv.url}/demo/present`);
  await expect(page.locator('#counter')).toHaveText(/^\d+ \/ 7$/);
  const s = srv.socket('demo');
  await s.send({ t: 'goto', index: 2 });
  await s.state((m) => m.index === 2);
  s.close();
  await expect(page.locator('#counter')).toHaveText('3 / 7');
  const link = page.locator('#edit-notes');
  await expect(link).toHaveText('Edit notes');
  await expect(link).toHaveAttribute('href', '/admin/edit/demo?slide=how&step=1');
  const [editor] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await expect(editor.locator('#counter')).toHaveText('3 / 7');
  await expect(editor.locator('label[for=step-note]')).toHaveText('Note for step 1');
  await editor.close();
});

test('the editor opens at a slide by id, at its first step when the step is unknown', async ({ page }) => {
  await page.goto(`${srv.url}/admin/edit/demo?slide=how&step=9`);
  await expect(page.locator('#counter')).toHaveText('2 / 7');
  await expect(page.locator('label[for=slide-notes]')).toHaveText('Slide notes (how)');
  await page.goto(`${srv.url}/admin/edit/demo?slide=gone`);
  await expect(page.locator('#counter')).toHaveText('1 / 7');
});

test('write a poll for a slide: saved to deck.json, marked in the step list, removed again', async ({ page, browser }) => {
  const presenterCtx = await browser.newContext();
  const presenter = await presenterCtx.newPage();
  await presenter.goto(`${srv.url}/demo/present`);
  await expect(presenter.locator('#counter')).toHaveText(/^\d+ \/ 7$/);
  const s = srv.socket('demo');
  await s.send({ t: 'goto', index: 5 }); // keys: no poll yet
  await s.state((m) => m.index === 5);
  s.close();
  await expect(presenter.locator('#counter')).toHaveText('6 / 7');
  await expect(presenter.locator('#poll-strip')).toBeHidden();

  await page.goto(`${srv.url}/admin/edit/demo?slide=keys`);
  await expect(page.locator('#counter')).toHaveText('6 / 7');
  await expect(page.locator('.e-group[data-slide=roles]')).toHaveClass(/has-poll/);
  await expect(page.locator('.e-group[data-slide=keys]')).not.toHaveClass(/has-poll/);
  await expect(page.locator('#poll-question')).toBeHidden();
  await page.click('#poll-add');
  await expect(page.locator('#poll-question')).toBeFocused();
  await page.keyboard.type('Which key blanks the screen?');
  await page.keyboard.press('Enter'); // on to the first answer
  await page.keyboard.type('B');
  await expect(page.locator('#poll-incomplete')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('F');
  await page.keyboard.press('Enter'); // a third answer, added at the end
  await page.keyboard.type('L');
  await expect(page.locator('#poll-options input')).toHaveCount(3);
  await expect(page.locator('#poll-incomplete')).toBeHidden();
  await page.check('#poll-kind-multiple');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  await expect(page.locator('.e-group[data-slide=keys]')).toHaveClass(/has-poll/);
  expect((await deckJson()).slides.keys.poll).toEqual({ question: 'Which key blanks the screen?', options: ['B', 'F', 'L'], multiple: true });
  expect((await deckJson()).slides.keys.notes).toBe('`B` blanks every viewer screen. Press it again to come back.');

  // The presenter on that slide can launch it at once.
  await expect(presenter.locator('#poll-strip')).toContainText('This slide has a poll');

  await page.click('#poll-options li:nth-child(2) button');
  await expect(page.locator('#poll-options input')).toHaveCount(2);
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect((await deckJson()).slides.keys.poll.options).toEqual(['B', 'L']);

  const remove = page.locator('#poll-editor .e-poll-foot button');
  await remove.click();
  await expect(remove).toHaveText('Remove?');
  await remove.click();
  await expect(page.locator('#poll-add')).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect('poll' in (await deckJson()).slides.keys).toBe(false);
  await expect(page.locator('.e-group[data-slide=keys]')).not.toHaveClass(/has-poll/);
  await expect(presenter.locator('#poll-strip')).toBeHidden();

  // Editing notes elsewhere never touches a poll it did not change.
  await page.goto(`${srv.url}/admin/edit/demo?slide=roles`);
  await page.fill('#slide-notes', 'Roles, edited');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  expect((await deckJson()).slides.roles.poll.question).toBe('Which role will you try first?');
  await presenterCtx.close();
});

test('a poll written by hand that is not valid is shown corrected, with a warning, and saved corrected', async ({ page }) => {
  const meta = await deckJson();
  meta.slides.end = { ...meta.slides.end, poll: { question: 'Twelve?', options: Array.from({ length: 12 }, (_, i) => `o${i + 1}`), multiple: 'no', mine: 'kept' } };
  await writeFile(join(srv.dataDir, 'demo', 'deck.json'), JSON.stringify(meta));
  await page.goto(`${srv.url}/admin/edit/demo?slide=end`);
  await expect(page.locator('#poll-fixed')).toBeVisible();
  await expect(page.locator('#poll-options input')).toHaveCount(10);
  await expect(page.locator('#poll-kind-single')).toBeChecked();
  // Opening the editor writes nothing; the next change on the slide does.
  expect((await deckJson()).slides.end.poll.multiple).toBe('no');
  await page.fill('#slide-notes', 'End, edited');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 5000 });
  const poll = (await deckJson()).slides.end.poll;
  expect(poll).toEqual({ question: 'Twelve?', options: Array.from({ length: 10 }, (_, i) => `o${i + 1}`), multiple: false, mine: 'kept' });
  await page.goto(`${srv.url}/admin/edit/demo?slide=end`);
  await expect(page.locator('#poll-fixed')).toBeHidden();
});
