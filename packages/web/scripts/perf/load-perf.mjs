// packages/web/scripts/perf/load-perf.mjs
// Browser measurements against an ISOLATED daemon (W2-E, plan 1A.3 and the hand-off):
//
//   PLAYWRIGHT_CORE=<dir of a playwright-core package> node scripts/perf/load-perf.mjs \
//       --url http://localhost:4125 --out <dir> --label after [--load] [--tour] [--stream]
//
//   --load    a cold load in a new browser context, desktop (1280x820) and phone (390x844), with
//             150 ms of added latency for each request (CDP Network.emulateNetworkConditions):
//             requests and bytes up to the first screen, time to first contentful paint, time to
//             the shell (the moment its navigation is in the document, on the page's clock). Five runs each; the median is reported.
//   --tour    opens each view on both widths and both themes, saves a screenshot of each, and
//             lists console errors, failed requests and chunks that did not load.
//   --stream  sends one message to the thread named "pretty thread" (the fake CLI of
//             fake-stream-claude.mjs answers with about 4,000 tokens) at 4x CPU throttle and
//             reports the long tasks and the main-thread script time during the stream.
//
// The daemon must be the isolated one (a fake HOME, a port from 4100 to 4199). Never the real one.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const URL_ = opt('url', 'http://localhost:4125');
const OUT = path.resolve(opt('out', '.dispatch/w2-e'));
const LABEL = opt('label', 'after');
const LATENCY = Number(opt('latency', 150));
if (!/:41\d\d(\/|$)/.test(URL_)) { console.error('load-perf: the URL must be an isolated daemon on a port from 4100 to 4199'); process.exit(2); }
if (!process.env.PLAYWRIGHT_CORE) { console.error('load-perf: set PLAYWRIGHT_CORE to the directory of a playwright-core package'); process.exit(2); }
const { chromium } = createRequire(path.join(process.env.PLAYWRIGHT_CORE, 'package.json'))('./index.js');
fs.mkdirSync(OUT, { recursive: true });

const SIZES = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } };
const SHELL = { desktop: 'nav[aria-label="Primary"]', phone: '[role="tablist"][aria-label="Projects view"]' };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const browser = await chromium.launch({ headless: true });
const result = { label: LABEL, url: URL_, latencyMs: LATENCY };

async function newPage(kind, { theme, latency = 0, cpu = 1 } = {}) {
  const context = await browser.newContext({ viewport: SIZES[kind], deviceScaleFactor: 1, isMobile: kind === 'phone', hasTouch: kind === 'phone', serviceWorkers: 'block' });
  if (theme) await context.addInitScript((t) => { try { localStorage.setItem('dispatch:theme', JSON.stringify(t)); } catch { /* no storage */ } }, theme);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (latency) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', (r) => { if (!/\/ws(\?|$)|\/api\/events/.test(r.url())) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', (r) => { if (r.status() >= 400 && /\/assets\//.test(r.url())) problems.push(`asset ${r.status()}: ${r.url()}`); });
  return { context, page, cdp, problems };
}

// ---------------------------------------------------------------------------------------------
if (has('load')) {
  result.load = {};
  for (const kind of ['desktop', 'phone']) {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const { context, page, cdp } = await newPage(kind, { latency: LATENCY });
      // The time the shell is in the document, on the page's own clock (a MutationObserver): no polling delay.
      await context.addInitScript((sel) => {
        const seen = () => { if (window.__shellAt === undefined && document.querySelector(sel)) window.__shellAt = Math.round(performance.now()); };
        document.addEventListener('DOMContentLoaded', () => { new MutationObserver(seen).observe(document.documentElement, { childList: true, subtree: true }); seen(); });
      }, SHELL[kind]);
      const reqs = new Map();
      cdp.on('Network.requestWillBeSent', (e) => { if (!reqs.has(e.requestId)) reqs.set(e.requestId, { url: e.request.url, type: e.type, start: e.timestamp, bytes: 0, done: null }); });
      cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.done = e.timestamp; } });
      const t0 = Date.now();
      await page.goto(URL_, { waitUntil: 'commit' });
      await page.waitForSelector(SHELL[kind], { state: 'visible', timeout: 60_000 });
      const shellMs = Date.now() - t0;
      const mark = await cdp.send('Runtime.evaluate', { expression: 'performance.timeOrigin + performance.now()', returnByValue: true });
      const paint = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)])));
      const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { responseEnd: Math.round(n.responseEnd), domContentLoaded: Math.round(n.domContentLoadedEventEnd) }; });
      // The resources that the page asked for before the shell showed (Resource Timing: startTime before the shell).
      const shellAt = await page.evaluate(() => window.__shellAt ?? performance.now());
      const res = await page.evaluate((limit) => performance.getEntriesByType('resource').filter((r) => r.startTime <= limit).map((r) => ({ name: r.name, start: Math.round(r.startTime), end: Math.round(r.responseEnd), size: r.transferSize, kind: r.initiatorType })), shellAt);
      void mark;
      const isAsset = (u) => /\/assets\/|theme-boot\.js|manifest\.webmanifest|\/icons\//.test(u);
      const assets = res.filter((r) => isAsset(r.name));
      const js = assets.filter((r) => /\.js(\?|$)/.test(r.name));
      runs.push({
        shellMs: Math.round(shellAt), waitedMs: shellMs, fcpMs: paint['first-contentful-paint'] ?? null, firstPaintMs: paint['first-paint'] ?? null, htmlMs: nav.responseEnd,
        requestsToShell: res.length + 1, assetRequests: assets.length, jsRequests: js.length, apiRequests: res.filter((r) => /\/api\//.test(r.name)).length,
        assetBytes: assets.reduce((n, r) => n + r.size, 0), jsBytes: js.reduce((n, r) => n + r.size, 0),
        lastJsEndMs: Math.max(0, ...js.map((r) => r.end)),
        jsFiles: js.map((r) => `${r.name.split('/').pop()} ${r.start}-${r.end}ms ${r.size}B`),
      });
      await context.close();
    }
    const pick = (k) => median(runs.map((r) => r[k] ?? 0));
    result.load[kind] = {
      shellMs: pick('shellMs'), fcpMs: pick('fcpMs'), htmlMs: pick('htmlMs'), lastJsEndMs: pick('lastJsEndMs'),
      requestsToShell: pick('requestsToShell'), assetRequests: pick('assetRequests'), jsRequests: pick('jsRequests'), apiRequests: pick('apiRequests'),
      assetBytes: pick('assetBytes'), jsBytes: pick('jsBytes'), jsFiles: runs[0].jsFiles, runsShellMs: runs.map((r) => r.shellMs),
    };
    console.log(`${LABEL} load ${kind}: ${JSON.stringify({ ...result.load[kind], jsFiles: undefined })}`);
    for (const f of runs[0].jsFiles) console.log(`    ${f}`);
  }
}

// ---------------------------------------------------------------------------------------------
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, `${LABEL}-${name}.png`) }); }
const settle = (page, ms = 900) => page.waitForTimeout(ms);
/** A view is fine when no error-boundary card and no endless spinner covers it. */
async function boundary(page) { return page.evaluate(() => /Something went wrong|failed to load|Failed to fetch dynamically imported module/i.test(document.body.innerText)); }

if (has('tour')) {
  result.tour = [];
  for (const theme of ['dispatch-dark', 'dispatch-light']) {
    for (const kind of ['desktop', 'phone']) {
      const { context, page, problems } = await newPage(kind, { theme });
      const tag = `${kind}-${theme.replace('dispatch-', '')}`;
      const step = async (name, fn) => {
        let ok = true; let note = '';
        try { await fn(); await settle(page); } catch (e) { ok = false; note = String(e).split('\n')[0].slice(0, 200); }
        const broken = await boundary(page);
        await shot(page, `${tag}-${name}`);
        result.tour.push({ tag, step: name, ok: ok && !broken, note: broken ? 'an error card is on screen' : note });
        console.log(`${LABEL} tour ${tag} ${name}: ${ok && !broken ? 'ok' : 'FAILED ' + (broken ? 'error card' : note)}`);
      };
      await page.goto(URL_);
      await page.waitForSelector(SHELL[kind], { state: 'visible', timeout: 60_000 });
      if (kind === 'desktop') {
        await step('1-threads', async () => { await page.getByRole('button', { name: /^(Threads|Projects)$/ }).first().click(); });
        await step('2-pretty-thread', async () => { await page.getByText('pretty thread').first().click(); await page.waitForSelector('.md-view', { timeout: 15_000 }); });
        await step('3-terminal', async () => { await page.getByText('sh', { exact: true }).first().click(); await page.waitForSelector('.xterm', { timeout: 20_000 }); });
        await step('4-file', async () => { await page.locator('[role="tab"]:has-text("files")').last().click(); await page.getByText('README.md').first().click(); await page.waitForSelector('.cm-editor, .md-view', { timeout: 20_000 }); });
        await step('5-control-plane', async () => { await page.locator('button[title^="Open "][title$=" coordinator"]').first().click(); await page.waitForSelector('.overseer-root', { timeout: 20_000 }); });
        await step('6-chat', async () => { await page.getByRole('button', { name: 'Chat', exact: true }).first().click(); });
        await step('7-analytics', async () => { await page.getByRole('button', { name: 'Analytics', exact: true }).first().click(); await page.waitForSelector('.recharts-wrapper, [data-testid="analytics-view"], h1, h2', { timeout: 20_000 }); });
        await step('8-settings', async () => { await page.getByRole('button', { name: 'Settings', exact: true }).first().click(); await page.getByText('Theme').first().waitFor({ timeout: 20_000 }); });
        await step('9-settings-about', async () => { await page.getByText('About & updates').first().click(); await page.getByText(/Version|version/).first().waitFor({ timeout: 20_000 }); });
        await step('10-palette', async () => { await page.keyboard.press('Meta+k'); });
      } else {
        await step('1-projects', async () => {});
        await step('2-project', async () => { await page.getByText('demo').first().click(); await page.getByText('pretty thread').first().waitFor({ timeout: 15_000 }); });
        await step('3-pretty-thread', async () => { await page.getByText('pretty thread').first().click(); await page.waitForSelector('.md-view', { timeout: 20_000 }); });
        await step('4-terminal', async () => { await page.goBack(); await page.getByText('sh', { exact: true }).first().click(); await page.waitForSelector('.xterm', { timeout: 20_000 }); });
        await step('5-control-plane', async () => { await page.goBack(); await page.locator('button[title^="Open "][title$=" coordinator"]').first().click(); await page.waitForSelector('.overseer-root', { timeout: 20_000 }); });
        await step('6-chat', async () => { await page.goto(URL_); await page.waitForSelector(SHELL[kind]); await page.getByRole('button', { name: /^Chat/ }).last().click(); });
        await step('7-analytics', async () => { await page.getByRole('button', { name: /^Analytics/ }).last().click(); });
        await step('8-settings', async () => { await page.getByRole('button', { name: /^Settings/ }).last().click(); await page.getByText('Appearance').first().waitFor({ timeout: 20_000 }); });
        await step('9-settings-appearance', async () => { await page.getByText('Appearance').first().click(); await page.getByText('Theme').first().waitFor({ timeout: 20_000 }); });
      }
      result.tour.push({ tag, step: 'problems', ok: problems.length === 0, note: problems.join(' | ') });
      console.log(`${LABEL} tour ${tag} problems: ${problems.length ? problems.join(' | ') : 'none'}`);
      await context.close();
    }
  }
}

// ---------------------------------------------------------------------------------------------
if (has('stream')) {
  const { context, page, cdp, problems } = await newPage('desktop', {});
  await page.goto(URL_);
  await page.waitForSelector(SHELL.desktop, { state: 'visible', timeout: 60_000 });
  await page.getByText('pretty thread').first().click();
  const box = page.locator('textarea, [contenteditable="true"]').last();
  await box.waitFor({ timeout: 20_000 });
  await settle(page, 1500);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
    window.__frames = 0; const tick = () => { window.__frames += 1; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Performance.enable');
  const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name)?.value ?? 0;
  const before = { script: await metric('ScriptDuration'), task: await metric('TaskDuration'), layout: await metric('LayoutDuration'), style: await metric('RecalcStyleDuration') };
  const frames0 = await page.evaluate(() => window.__frames);
  const t0 = Date.now();
  await box.click();
  await page.keyboard.type('Write the long plan please');
  await page.keyboard.press('Enter');
  await page.getByText('That is the full plan.').last().waitFor({ timeout: 300_000 });
  await settle(page, 1500);
  const seconds = (Date.now() - t0) / 1000;
  const after = { script: await metric('ScriptDuration'), task: await metric('TaskDuration'), layout: await metric('LayoutDuration'), style: await metric('RecalcStyleDuration') };
  const long = await page.evaluate(() => window.__long);
  const frames = (await page.evaluate(() => window.__frames)) - frames0;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await settle(page, 800);
  await shot(page, 'stream-end');
  const codeBlocks = await page.locator('.md-view pre').count();
  result.stream = {
    cpuThrottle: 4, seconds: +seconds.toFixed(1), longTasks: long.length, longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)), longestTaskMs: Math.round(Math.max(0, ...long)),
    scriptSeconds: +(after.script - before.script).toFixed(2), taskSeconds: +(after.task - before.task).toFixed(2), layoutSeconds: +(after.layout - before.layout).toFixed(2), styleSeconds: +(after.style - before.style).toFixed(2),
    framesPerSecond: +(frames / seconds).toFixed(1), codeBlocksOnScreen: codeBlocks, problems,
  };
  console.log(`${LABEL} stream: ${JSON.stringify(result.stream)}`);
  await context.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, `${LABEL}-results.json`), JSON.stringify(result, null, 2));
