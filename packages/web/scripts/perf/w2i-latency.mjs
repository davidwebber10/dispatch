// W2-I perf and manual verification (plan section 4A, W2-I acceptance). Measures, against an ISOLATED daemon
// that w2i-seed.mjs seeded, in fresh browser contexts with 150 ms of added latency (CDP):
//   - tab switch back: time and frames from the click to the thread's content
//   - send: time and frames from Enter to the owner's bubble
//   - archive: time and frames from Confirm to the row gone
//   - replay bytes on the wire: a 200-event Pretty thread, and a terminal with a 4 MB ring
// Two latency models, both reported (MODEL=cdp|path, default: both):
//   cdp   Network.emulateNetworkConditions, latency 150 ms. Chrome applies it to HTTP responses only: a request
//         reaches the daemon at once and WebSocket frames are not delayed. So an action whose result comes back on
//         a socket (the echo of a sent message) looks instant in this model even on the old code.
//   path  every HTTP request and every WebSocket frame waits 75 ms in each direction (150 ms round trip), and a
//         WebSocket connect waits one round trip, through Playwright's route and routeWebSocket. This is the model
//         that is close to a Tailscale link.
//   - a slow resume: the daemon is stopped for 3 s (SIGSTOP) while the app resumes; is the view remounted?
// Run:
//   BASE=http://localhost:4129 TOKEN_FILE=<fake home>/.dispatch/access-token SEED=<seed json> DAEMON_PID=<pid>
//   PW=<dir of playwright-core> LABEL=before|after OUT=<dir for screenshots and the json>
//   node packages/web/scripts/perf/w2i-latency.mjs
// DAEMON_PID must be the isolated daemon that YOU started. Never point this at a real daemon.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire(new URL('../../../core/package.json', import.meta.url))('ws');
const { chromium } = createRequire(path.join(process.env.PW, 'package.json'))('playwright-core');

const BASE = process.env.BASE ?? 'http://localhost:4129';
if (/:3456\b/.test(BASE)) { console.error('refusing to run against the real daemon'); process.exit(2); }
const LABEL = process.env.LABEL ?? 'run';
const OUT = process.env.OUT ?? '.';
const LATENCY = Number(process.env.LATENCY ?? 150);
const seed = JSON.parse(fs.readFileSync(process.env.SEED, 'utf8'));
const token = fs.readFileSync(process.env.TOKEN_FILE, 'utf8').trim();
const daemonPid = Number(process.env.DAEMON_PID);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const RUNS = process.env.QUICK ? 1 : 5;
const result = { label: LABEL, latencyMs: LATENCY };

// ---------- replay bytes (a WebSocket client that offers permessage-deflate, as a browser does) ----------
async function wsBytes(pathAndQuery, { deflate = true, idleMs = 700 } = {}) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + pathAndQuery, { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: deflate });
  let socket; let extensions = ''; const frames = []; let last = Date.now();
  ws.on('upgrade', (res) => { socket = res.socket; extensions = String(res.headers['sec-websocket-extensions'] ?? ''); });
  ws.on('message', (d) => { frames.push(d.toString()); last = Date.now(); });
  await new Promise((r, rej) => { ws.on('open', r); ws.on('error', rej); });
  last = Date.now();
  while (Date.now() - last < idleMs) await sleep(50);
  const out = { frames: frames.length, payloadBytes: frames.reduce((n, f) => n + Buffer.byteLength(f), 0), wireBytes: socket.bytesRead, deflate: extensions.includes('permessage-deflate'), data: frames };
  ws.close();
  return out;
}
const strip = ({ data: _d, ...rest }) => rest;
// Two replays of one terminal are two windows on the same output stream. The ring is full, so each connect (its
// repaint adds a few bytes) moves the window: compare the part both hold, placed by the meta frame's startOffset.
// The seeded output is ASCII, so a byte offset is a character offset.
function sameStream(a, b) {
  const [ma, mb] = [JSON.parse(a.data[0]), JSON.parse(b.data[0])];
  const [ra, rb] = [a.data[1], b.data[1]];
  const start = Math.max(ma.startOffset, mb.startOffset);
  const end = Math.min(ma.startOffset + ra.length, mb.startOffset + rb.length);
  const [pa, pb] = [ra.slice(start - ma.startOffset, end - ma.startOffset), rb.slice(start - mb.startOffset, end - mb.startOffset)];
  return { comparedBytes: pa.length, identical: pa.length > 0 && pa === pb };
}
{
  const old = await wsBytes(`/api/terminals/${seed.alpha}/structured-ws?tail=200`);
  const batch = await wsBytes(`/api/terminals/${seed.alpha}/structured-ws?tail=200&batch=1`);
  const unpack = (r) => r.data.flatMap((f) => { const m = JSON.parse(f); return m.type === 'replay' ? m.events : [m]; });
  result.structuredReplay = {
    'as the web client of the base asks (tail=200)': strip(old),
    'as the web client of this branch asks (tail=200&batch=1)': strip(batch),
    eventsOld: unpack(old).length, eventsBatch: unpack(batch).length,
    sameEventsInOrder: JSON.stringify(unpack(old)) === JSON.stringify(unpack(batch)),
  };
  const t4 = await wsBytes(`/api/terminals/${seed.shell}/ws?replayBytes=4000000&meta=1`, { idleMs: 1500 });
  const t1 = await wsBytes(`/api/terminals/${seed.shell}/ws?replayBytes=1000000&meta=1`, { idleMs: 1500 });
  const plain = await wsBytes(`/api/terminals/${seed.shell}/ws?replayBytes=4000000&meta=1`, { deflate: false, idleMs: 1500 });
  result.terminalReplay = {
    'replayBytes=4000000 (what desktop asked for on the base)': strip(t4),
    'replayBytes=1000000 (what desktop asks for on this branch)': strip(t1),
    'replayBytes=4000000, a client with no deflate': strip(plain),
    // The compressed replay against the plain one, byte for byte (see sameStream).
    replayIdenticalWithAndWithoutDeflate: sameStream(t4, plain),
    replayFrameBytes: Buffer.byteLength(t4.data[1] ?? ''),
  };
}

// ---------- the browser ----------
const browser = await chromium.launch();
let MODEL = 'cdp';
async function fresh({ width = 1400, height = 900, colorScheme = 'dark', latency = LATENCY, ready = 'Alpha' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
  await ctx.addInitScript(() => { try { localStorage.setItem('dispatch:theme', JSON.stringify('system')); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const setLatency = (ms) => cdp.send('Network.emulateNetworkConditions', { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 });
  if (MODEL === 'cdp') await setLatency(latency);
  else if (latency > 0) {
    const half = latency / 2;
    await page.route('**/api/**', async (route) => {
      await sleep(half);
      let res;
      try { res = await route.fetch(); } catch { return route.abort().catch(() => {}); }
      await sleep(half);
      await route.fulfill({ response: res }).catch(() => {});
    });
    await page.routeWebSocket(/\/api\//, async (ws) => {
      // One queue for each direction, so the frames keep their order.
      let up = sleep(latency); // the connect: one round trip
      let server;
      up = up.then(() => { server = ws.connectToServer(); let down = Promise.resolve();
        server.onMessage((m) => { down = Promise.all([down, sleep(half)]).then(() => { try { ws.send(m); } catch { /* closed */ } }); });
        server.onClose((code, reason) => { down = down.then(() => sleep(half)).then(() => { try { ws.close({ code, reason }); } catch { /* closed */ } }); });
      });
      ws.onMessage((m) => { up = Promise.all([up, sleep(half)]).then(() => { try { server.send(m); } catch { /* closed */ } }); });
      ws.onClose((code, reason) => { up = up.then(() => { try { server?.close({ code, reason }); } catch { /* closed */ } }); });
    });
  }
  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto(BASE);
  await page.getByText(ready, { exact: true }).first().waitFor();
  return { ctx, page, setLatency, sockets };
}
// In the page: run `action`, then count the time and the animation frames until `done()` is true.
const timed = (page, actionSrc, doneSrc) => page.evaluate(async ([a, d]) => {
  const action = new Function(`return (${a})`)(); const done = new Function(`return (${d})`)();
  const t0 = performance.now();
  await action();
  if (done()) return { ms: Math.round(performance.now() - t0), frames: 0 };
  return new Promise((resolve) => {
    let frames = 0;
    const tick = () => { frames++; if (done()) resolve({ ms: Math.round(performance.now() - t0), frames }); else if (performance.now() - t0 > 20000) resolve({ ms: -1, frames }); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}, [actionSrc, doneSrc]);
const rowClick = (label) => `() => { const el = [...document.querySelectorAll('span,div,button')].find((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(label)}); el.click(); }`;
const hasText = (text) => `() => document.body.innerText.includes(${JSON.stringify(text)})`;
const LAST_ALPHA = 'echo:Alpha question 69';
const LAST_BETA = 'echo:Beta question 3';

const doomed = ['Doomed one', 'Doomed two', 'Doomed three', 'Doomed four', 'Doomed five', 'Doomed six'];
for (MODEL of (process.env.ONLY ? [] : process.env.MODEL ? [process.env.MODEL] : ['cdp', 'path'])) {
  result[MODEL] = {};
  // 1. tab switch back
  {
    const runs = [];
    let first;
    for (let i = 0; i < RUNS; i++) {
      const { ctx, page } = await fresh();
      const open = await timed(page, rowClick('Alpha'), hasText(LAST_ALPHA)); // the first open of the thread (no cache possible)
      if (i === 0) first = open;
      await timed(page, rowClick('Beta'), hasText(LAST_BETA));
      await sleep(600);
      runs.push(await timed(page, rowClick('Alpha'), hasText(LAST_ALPHA)));
      if (i === 0) await page.screenshot({ path: path.join(OUT, `${LABEL}-${MODEL}-switch-back.png`) });
      await ctx.close();
    }
    result[MODEL].tabSwitchBack = { firstOpen: first, runs, medianMs: median(runs.map((r) => r.ms)), medianFrames: median(runs.map((r) => r.frames)) };
  }

  // 2. send to bubble
  {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const { ctx, page } = await fresh();
      await timed(page, rowClick('Beta'), hasText(LAST_BETA));
      const text = `latency probe ${LABEL} ${Date.now()} ${i}`;
      const box = page.getByPlaceholder('Message…').first();
      await box.click();
      await page.keyboard.type(text);
      await sleep(300);
      // The bubble: the text in the document outside the composer (a textarea's value is not in innerText).
      const r = await timed(page, `() => { const el = document.activeElement; const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }; el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); }`, hasText(text));
      runs.push(r);
      const reply = await timed(page, '() => {}', hasText(`echo:${text}`));
      await sleep(400);
      const bubbles = await page.evaluate((t) => document.body.innerText.split(t).length - 1, text);
      r.replyAfterMs = reply.ms; r.timesShown = bubbles; // 2 = the bubble once + the echo:<text> reply once
      if (i === 0) await page.screenshot({ path: path.join(OUT, `${LABEL}-${MODEL}-send.png`) });
      await ctx.close();
    }
    result[MODEL].sendToBubble = { runs, medianMs: median(runs.map((r) => r.ms)), medianFrames: median(runs.map((r) => r.frames)) };
  }

  // 3. archive to row gone
  {
    const runs = [];
    for (const label of doomed.splice(0, 3)) {
      const { ctx, page } = await fresh();
      await page.getByText(label, { exact: true }).first().click({ button: 'right' });
      await page.getByText('Archive thread', { exact: true }).click();
      await page.getByRole('button', { name: 'Archive', exact: true }).waitFor();
      await sleep(300);
      const r = await timed(page,
        `() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Archive').click(); }`,
        `() => ![...document.querySelectorAll('span,div')].some((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(label)})`);
      runs.push({ label, ...r });
      await sleep(1200);
      r.stillGoneAfter1200ms = await page.evaluate((l) => ![...document.querySelectorAll('span,div')].some((e) => e.childElementCount === 0 && e.textContent.trim() === l), label);
      if (runs.length === 1) await page.screenshot({ path: path.join(OUT, `${LABEL}-${MODEL}-archive.png`) });
      await ctx.close();
    }
    result[MODEL].archiveToRowGone = { runs, medianMs: median(runs.map((r) => r.ms)), medianFrames: median(runs.map((r) => r.frames)) };
  }
}
MODEL = 'cdp';

// 4. a slow resume: the daemon answers nothing for `stopMs`, while the app comes back to the foreground
async function resume(stopMs) {
  const { ctx, page, sockets } = await fresh();
  await timed(page, rowClick('Alpha'), hasText(LAST_ALPHA));
  await sleep(800);
  // Mark the chat view's DOM (its composer): a remount makes new nodes, so the mark is gone from the document.
  // The message node is marked too, for information only: a replay may draw a message again with a new node.
  await page.evaluate((t) => { window.__composer = document.querySelector('textarea'); const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.includes(t)); window.__mark = el; window.__blank = 0; const watch = () => { if (!document.body.innerText.includes(t)) window.__blank++; requestAnimationFrame(watch); }; requestAnimationFrame(watch); }, LAST_ALPHA);
  const before = sockets.length;
  process.kill(daemonPid, 'SIGSTOP');
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // one of useResume's three signals
  await sleep(stopMs);
  process.kill(daemonPid, 'SIGCONT');
  await sleep(6000);
  const out = await page.evaluate((t) => ({ composerStillInDocument: !!window.__composer?.isConnected, messageNodeStillInDocument: !!window.__mark?.isConnected, framesWithoutContent: window.__blank, contentShown: document.body.innerText.includes(t) }), LAST_ALPHA);
  out.newSockets = sockets.slice(before).map((u) => u.replace(/^.*\/api\//, '/api/').replace(/[0-9a-f-]{36}/, '<id>'));
  out.remounted = !out.composerStillInDocument;
  await page.screenshot({ path: path.join(OUT, `${LABEL}-resume-${stopMs}ms.png`) });
  await ctx.close();
  return out;
}
if (daemonPid && process.env.ONLY !== 'ui') {
  result.slowResume3s = await resume(3000);   // pong after 3 s: under the new 4 s wait, over the old 1.5 s
  result.deadFor6s = await resume(6000);      // no pong in time on either build: the sockets must come back
}

const save = () => fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(result, null, 2));
save();

// 5. screenshots of the changed UI (this branch only): the bubble while sending, and a refused send
if (LABEL === 'after') {
  for (const [name, opts] of [['desktop-dark', {}], ['desktop-light', { colorScheme: 'light' }], ['phone-dark', { width: 390, height: 844 }], ['phone-light', { width: 390, height: 844, colorScheme: 'light' }]]) {
    const { ctx, page } = await fresh({ ...opts, latency: 0, ready: opts.width ? 'Latency' : 'Alpha' });
    if (opts.width) await page.getByText('Latency', { exact: true }).first().click(); // the phone: project list, then its threads
    await page.getByText('Beta', { exact: true }).first().click();
    await page.getByText(LAST_BETA).first().waitFor();
    await page.route('**/api/terminals/*/message', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'the daemon could not be reached' }) }));
    const box = page.getByPlaceholder('Message…').first();
    await box.click();
    await page.keyboard.type('This message is refused by the test');
    await page.keyboard.press('Enter');
    await page.getByText('Not sent').first().waitFor({ timeout: 5000 });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, `ui-failed-send-${name}.png`) });
    await ctx.close();
  }
}

await browser.close();
if (process.env.ONLY !== 'ui') save();
console.log(JSON.stringify(result, null, 2));
