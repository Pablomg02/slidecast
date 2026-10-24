// Renders the social preview: npm run site:social
// Opens site/social/preview.html, shows the demo deck's "mix" slide on both
// screens and writes docs/assets/social-preview.png (1280×640, the size GitHub
// asks for). Set it on GitHub under Settings → Social preview; the website
// links the same file.
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'docs', 'assets', 'social-preview.png');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.goto(pathToFileURL(join(here, 'preview.html')).href);
  for (const frame of page.frames().slice(1)) {
    await frame.waitForFunction(() => window.SLIDECAST_DECK);
    await frame.evaluate(() => {
      const steps = window.SLIDECAST_DECK.steps;
      window.SLIDECAST_DECK.go(steps.findIndex((s) => s.slide === 'mix' && s.step === 2));
    });
  }
  await page.waitForTimeout(1500); // the waves draw themselves in
  await page.screenshot({ path: out });
  console.log('Wrote docs/assets/social-preview.png');
} finally {
  await browser.close();
}
