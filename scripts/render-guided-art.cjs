/*
 * Renders assets/social/guided-setup.jpg, the 960x1200 art the retrac.space guided sign-in
 * page shows for Digital Tug of War, from scripts/templates/guided-setup.html.
 *
 * Uses a locally installed Chrome (or Edge) through playwright-core.
 *
 *   npm run build:art
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'templates/guided-setup.html');
const OUT = path.join(ROOT, 'assets/social/guided-setup.jpg');

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      // Try the next browser.
    }
  }
  return chromium.launch({ headless: true }); // A Playwright-installed Chromium, if any.
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 1200 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.error('Art error:', error.message));
  await page.goto(pathToFileURL(TEMPLATE).href);
  // The icon is an <image> inside the SVG, so wait for it to decode before the screenshot.
  await page.evaluate(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = resolve;
    img.src = document.querySelector('image').getAttribute('href');
  }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: OUT, type: 'jpeg', quality: 88 });
  await browser.close();
  console.log('Rendered ' + path.relative(ROOT, OUT));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
