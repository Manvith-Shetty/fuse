// Usage: node screenshot.mjs http://localhost:3000[/route] [label]
// Saves to ./temporary screenshots/screenshot-N[-label].png (auto-incremented, never overwritten).
// Env: WIDTH, HEIGHT (viewport; default 1440x900), TOKEN (preloaded into localStorage as "token"), FULL=0 to disable full-page capture.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
const label = process.argv[3];
if (!url || !/^https?:\/\//.test(url)) { console.error('usage: node screenshot.mjs http://localhost:3000 [label]'); process.exit(1); }
if (/^file:/.test(url)) { console.error('never screenshot file:// URLs; serve on localhost'); process.exit(1); }

const dir = path.join(here, 'temporary screenshots');
fs.mkdirSync(dir, { recursive: true });
const taken = fs.readdirSync(dir).map(f => /^screenshot-(\d+)/.exec(f)?.[1]).filter(Boolean).map(Number);
const n = (taken.length ? Math.max(...taken) : 0) + 1;
const file = path.join(dir, `screenshot-${n}${label ? `-${label}` : ''}.png`);

const width = Number(process.env.WIDTH ?? 1440), height = Number(process.env.HEIGHT ?? 900);
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (process.env.TOKEN) await page.evaluateOnNewDocument((t) => localStorage.setItem('token', t), process.env.TOKEN);
  // SCHEME=light|dark picks the colour scheme (default light, the product default); the OS setting is not used.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.SCHEME === 'dark' ? 'dark' : 'light' }]);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, Number(process.env.SETTLE_MS ?? 1500)));
  if (process.env.FULL !== '0') {
    // walk the page so scroll-revealed sections are in view, then return to the top
    await page.evaluate(async () => {
      const h = () => document.documentElement.scrollHeight;
      for (let y = 0; y < h(); y += 300) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 120)); }
      window.scrollTo({ top: h(), behavior: 'instant' }); await new Promise(r => setTimeout(r, 200));
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await new Promise(r => setTimeout(r, 800));
  }
  await page.screenshot({ path: file, fullPage: process.env.FULL !== '0' });
  console.log(file);
} finally { await browser.close(); }
