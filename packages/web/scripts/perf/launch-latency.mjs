// W2-H perf probe (plan section 1A.3). Not part of the build or the tests.
// Needs playwright-core (not a dependency of this repo: `npm i playwright-core` in a scratch folder and run the
// script from there) and a Chromium from the Playwright cache (see EXE below).
// Run against an ISOLATED daemon only (HOME=<fake> PORT=41xx), with some projects and threads in it.
//   node launch-latency.mjs <label> <outDir> [latencyMs=150] [port=4128] [basePath]
// Measures a cold launch, a warm launch and a reconnect, with CDP added latency on the page.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [label, outDir, latencyArg, portArg] = process.argv.slice(2);
const LATENCY = Number(latencyArg ?? 150);
const PORT = Number(portArg ?? 4128);
const ORIGIN = `http://localhost:${PORT}`;
const BASEP = process.argv[6] ?? ''; // the mount prefix under DISPATCH_BASE_PATH, e.g. /u/dw/dispatch
const EXE = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
fs.mkdirSync(outDir, { recursive: true });

const INIT = `
  window.__marks = {};
  window.__sockets = [];
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS { constructor(...a) { super(...a); window.__sockets.push(this); } };
  const seen = (k) => { if (window.__marks[k] === undefined) { const t = performance.now(); window.__marks[k + ':dom'] = t; requestAnimationFrame(() => requestAnimationFrame(() => { window.__marks[k] = performance.now(); })); window.__marks[k] = -1; } };
  const scan = () => {
    const txt = document.body ? document.body.innerText : '';
    if (/Project \\d/.test(txt)) seen('projects');
    if (/thread \\d-\\d/.test(txt)) seen('threads');
  };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true });
`;

async function launchPage(context, name, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  const reqs = [];
  const t0 = Date.now();
  const byReq = new Map();
  page.on('request', (r) => {
    const row = { t: Date.now() - t0, method: r.method(), url: r.url().replace(ORIGIN + BASEP, ''), type: r.resourceType(), sw: null, status: null, end: null };
    byReq.set(r, row); reqs.push(row);
  });
  page.on('response', (res) => { const row = byReq.get(res.request()); if (row) { row.sw = res.fromServiceWorker(); row.status = res.status(); } });
  page.on('requestfinished', (r) => { const row = byReq.get(r); if (row) row.end = Date.now() - t0; });
  const ws = [];
  page.on('websocket', (w) => ws.push({ t: Date.now() - t0, url: w.url().replace(/^ws:\/\/[^/]+/, '') }));
  await page.goto(ORIGIN + BASEP + '/', { waitUntil: 'commit' });
  const listKey = viewport.width <= 768 ? 'projects' : 'threads'; // a phone launches on the project list
  let marks = {};
  for (let i = 0; i < 600; i++) { marks = await page.evaluate(() => window.__marks); if (marks[listKey] > 0) break; await page.waitForTimeout(25); }
  if (!(marks[listKey] > 0)) throw new Error('the list did not paint');
  const paintAt = Date.now() - t0;
  await page.waitForTimeout(4000); // let the launch burst finish (idle preloads included)
  const perf = await page.evaluate(() => ({
    nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { responseStart: n.responseStart, workerStart: n.workerStart, transferSize: n.transferSize, domContentLoaded: n.domContentLoadedEventEnd } : null; })(),
    fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    blocking: performance.getEntriesByType('resource').filter((e) => e.renderBlockingStatus === 'blocking').map((e) => ({ name: new URL(e.name).pathname, transferSize: e.transferSize, workerStart: e.workerStart, duration: e.duration })),
  }));
  await page.screenshot({ path: path.join(outDir, `${label}-${name}.png`) });
  // "Before the list": requests that started before the thread list was in the DOM.
  const listAt = marks[listKey];
  const net = (r) => r.sw === false;      // answered by the network, not by the service worker
  const api = reqs.filter((r) => r.url.startsWith('/api/'));
  const out = {
    name, latencyMs: LATENCY, viewport,
    timeToProjectsMs: Math.round(marks['projects']), timeToThreadListMs: marks['threads'] > 0 ? Math.round(marks['threads']) : null, timeToListMs: Math.round(listAt), fcpMs: perf.fcp && Math.round(perf.fcp),
    nav: perf.nav,
    renderBlockingFromNetwork: perf.blocking.filter((b) => b.transferSize > 0).map((b) => b.name),
    renderBlocking: perf.blocking,
    requestCount: reqs.length,
    networkRequestCount: reqs.filter(net).length,
    apiRequestCount: api.length,
    apiRequests: api.map((r) => `${r.t}ms ${r.method} ${r.url} -> ${r.status} (${r.end}ms)`),
    staticRequests: reqs.filter((r) => !r.url.startsWith('/api/')).map((r) => `${r.t}ms ${r.url} [${r.type}] sw=${r.sw} -> ${r.status} (${r.end}ms)`),
    networkBeforeList: reqs.filter((r) => net(r) && r.end !== null && r.end <= paintAt && !r.url.startsWith('/api/')).map((r) => r.url),
    websockets: ws,
  };
  return { page, cdp, out, reqs, t0 };
}

async function run(viewportName, viewport) {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  await context.addInitScript(INIT);
  const result = { label, viewportName };

  // 1. Cold: nothing saved, no service worker.
  const cold = await launchPage(context, `${viewportName}-cold`, viewport);
  result.cold = cold.out;
  await cold.page.evaluate(() => navigator.serviceWorker.ready);
  await cold.page.waitForTimeout(2500); // the launch snapshot saves 1.5 s after the lists change
  await cold.page.close();

  // 2. A second launch lets the (now controlling) service worker save the build files.
  const prime = await launchPage(context, `${viewportName}-prime`, viewport);
  await prime.page.waitForTimeout(2500);
  await prime.page.close();

  // 3. Warm: the saved shell, saved files and the launch snapshot are there.
  const warm = await launchPage(context, `${viewportName}-warm`, viewport);
  result.warm = warm.out;

  // 4. Reconnect: drop the events socket from the page side, then count the requests that follow.
  const before = warm.reqs.length;
  const tDrop = Date.now() - warm.t0;
  const dropped = await warm.page.evaluate(() => {
    const s = window.__sockets.filter((x) => /\/api\/events(\?|$)/.test(x.url) && x.readyState === 1);
    s.forEach((x) => x.close());
    return s.length;
  });
  await warm.page.waitForTimeout(8000);
  const after = warm.reqs.slice(before);
  result.reconnect = {
    socketsDropped: dropped,
    requestCount: after.length,
    listRequests: after.filter((r) => /\/terminals(\?|$)/.test(r.url) && !/stalls/.test(r.url)).length,
    requests: after.map((r) => `+${r.t - tDrop}ms ${r.method} ${r.url} -> ${r.status}`),
  };
  await warm.page.close();
  await browser.close();
  return result;
}

const results = [];
results.push(await run('desktop', { width: 1280, height: 800 }));
results.push(await run('phone', { width: 390, height: 844 }));
fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n== ${label} / ${r.viewportName} (latency ${LATENCY} ms) ==`);
  for (const k of ['cold', 'warm']) {
    const o = r[k];
    console.log(`${k}: projects ${o.timeToProjectsMs} ms, thread list ${o.timeToThreadListMs} ms, list ${o.timeToListMs} ms, FCP ${o.fcpMs} ms; requests ${o.requestCount} (network ${o.networkRequestCount}, api ${o.apiRequestCount}); render-blocking from network: ${JSON.stringify(o.renderBlockingFromNetwork)}; non-API network before list: ${JSON.stringify(o.networkBeforeList)}`);
  }
  console.log(`reconnect: ${r.reconnect.requestCount} requests, ${r.reconnect.listRequests} list requests (sockets dropped ${r.reconnect.socketsDropped})`);
}
