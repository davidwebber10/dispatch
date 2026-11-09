// W2-H manual check (plan section 1A.1 rule 5). Not part of the build or the tests. Same needs as launch-latency.mjs.
// It writes a fake new build into <web dist> (a copy of the entry under a new name) and puts the files back at the end.
//   node update-flow.mjs <web dist of the isolated daemon on port 4128> <outDir>
import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const [dist, outDir] = process.argv.slice(2);
const ORIGIN = 'http://localhost:4128';
const EXE = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: -1, uploadThroughput: -1 });
const reqs = [];
page.on('request', (r) => reqs.push(r));
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
await page.goto(ORIGIN + '/');
await page.waitForFunction(() => /thread \d-\d/.test(document.body.innerText));
await page.evaluate(() => navigator.serviceWorker.ready);
const cached = async () => page.evaluate(async () => {
  const out = {};
  for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname).sort();
  return out;
});
// 1. Lazy chunks: wait for the idle message to be handled.
let c = {};
for (let i = 0; i < 80; i++) { c = await cached(); if (Object.values(c).flat().some((p) => /AnalyticsView/.test(p))) break; await page.waitForTimeout(500); }
console.log('caches after idle:', JSON.stringify(c, null, 1));
// 2. A new build: a copy of the entry under a new name, and index.html names it.
const indexFile = path.join(dist, 'index.html');
const original = fs.readFileSync(indexFile, 'utf8');
const entry = original.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)[1];
const next = 'index-W2Htest1.js';
fs.copyFileSync(path.join(dist, 'assets', entry), path.join(dist, 'assets', next));
fs.writeFileSync(indexFile, original.replace(entry, next));
try {
  const before = reqs.length;
  const t0 = Date.now();
  const navigated = page.waitForEvent('framenavigated', { timeout: 30000 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await navigated;
  const tReload = Date.now() - t0;
  await page.waitForFunction(() => /thread \d-\d/.test(document.body.innerText));
  const tList = Date.now() - t0;
  const src = await page.evaluate(() => document.querySelector('script[type="module"]').src);
  await page.waitForTimeout(1500);
  const rows = [];
  for (const r of reqs.slice(before)) { const res = await r.response().catch(() => null); rows.push(`${r.method()} ${r.url().replace(ORIGIN, '')} [${r.resourceType()}] sw=${res ? res.fromServiceWorker() : '?'} ${res ? res.status() : ''}`); }
  console.log('entry now:', src);
  console.log(`focus -> reload started ${tReload} ms; focus -> list painted again ${tList} ms`);
  console.log('requests from the focus to the end:\n ' + rows.join('\n '));
  await page.screenshot({ path: path.join(outDir, 'after-update-reload.png') });
} finally {
  fs.writeFileSync(indexFile, original);
  fs.rmSync(path.join(dist, 'assets', next), { force: true });
}
console.log('console errors:', JSON.stringify(consoleErrors));
await browser.close();
