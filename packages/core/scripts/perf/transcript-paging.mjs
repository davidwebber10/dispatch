// Transcript paging check (plan section 1A.3, W2-B): pages a 100 MB synthetic Claude transcript 50
// times through an isolated daemon, while a second client measures the latency of GET /api/sessions.
// It reports the time for each page, the daemon's event-loop delay (p99, max) and its RSS.
//
// Run from the worktree root, once for each build (the same machine, the same file):
//   node packages/core/scripts/perf/transcript-paging.mjs <label> <core dist dir> [megabytes]
//   e.g.  node packages/core/scripts/perf/transcript-paging.mjs before packages/core/dist-before
//         node packages/core/scripts/perf/transcript-paging.mjs after  packages/core/dist
// The fake HOME is /private/tmp/claude-501/w2-b-home/<label>. The port is 4122. Never 3456, never the real HOME.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSyntheticTranscript } from './synthetic-transcript.mjs';

const [label, distArg, mbArg] = process.argv.slice(2);
if (!label || !distArg) { console.error('usage: transcript-paging.mjs <label> <core dist dir> [megabytes]'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(distArg);
const megabytes = Number(mbArg ?? 100);
const PORT = Number(process.env.W2B_PORT ?? 4122);
const home = path.join('/private/tmp/claude-501/w2-b-home', label);
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── seed (before the daemon starts) ──
process.env.HOME = home;
fs.rmSync(home, { recursive: true, force: true });
const workDir = '/tmp/w2b-perf';
const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, 'big-session.jsonl');
const made = writeSyntheticTranscript(transcript, megabytes * 1024 * 1024);
fs.mkdirSync(path.join(home, '.dispatch'), { recursive: true, mode: 0o700 });
const { createDatabase } = await import(pathToFileURL(path.join(dist, 'db/connection.js')).href);
const db = createDatabase(path.join(home, '.dispatch', 'dispatch.db'));
const now = new Date().toISOString();
db.prepare("INSERT OR IGNORE INTO sessions (id, provider, name, working_dir, status, created_at, updated_at, last_activity_at) VALUES ('perf-project','claude-code','perf',?, 'waiting', ?,?,?)").run(workDir, now, now, now);
db.prepare("INSERT OR IGNORE INTO terminals (id, session_id, type, label, external_id, working_dir, status, created_at, archived_at) VALUES ('big-thread','perf-project','claude-code','big','big-session',?, 'waiting', ?, ?)").run(workDir, now, now);
db.close();

// ── the daemon, with the probe loaded first ──
const probeOut = path.join(home, 'probe.json');
const env = { ...process.env, HOME: home, PORT: String(PORT), DISPATCH_TELEMETRY: '0', W2B_PROBE_OUT: probeOut };
for (const k of ['DISPATCH_API', 'DISPATCH_AUTH', 'DISPATCH_SESSION', 'DISPATCH_TERMINAL']) delete env[k];
if (process.env.W2B_WEB_DIST) env.DISPATCH_WEB_DIST = process.env.W2B_WEB_DIST;
const log = fs.openSync(path.join(home, 'daemon.log'), 'w');
const daemon = spawn(process.execPath, ['--import', path.join(here, 'loop-delay-probe.mjs'), path.join(dist, 'server.js')], { env, stdio: ['ignore', log, log] });
const stop = () => { try { daemon.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);

async function probe() {
  fs.rmSync(probeOut, { force: true });
  daemon.kill('SIGUSR2');
  for (let i = 0; i < 100 && !fs.existsSync(probeOut); i++) await sleep(20);
  await sleep(20);
  return JSON.parse(fs.readFileSync(probeOut, 'utf8'));
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (n) => Math.round(n * 10) / 10;
  return { n: s.length, min: r(s[0]), p50: r(at(0.5)), p99: r(at(0.99)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
};
async function timed(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const body = await res.json();
  return { ms: performance.now() - t0, status: res.status, body };
}

try {
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`${base}/api/sessions`)).ok; } catch { await sleep(100); } }
  if (!up) throw new Error('the daemon did not start; see ' + path.join(home, 'daemon.log'));
  await sleep(1500); // boot work is over
  const idle = await probe();
  await sleep(300);
  await probe(); // start a clean window (the monitor needs a tick after a reset)
  await sleep(100);

  // A second client: the latency of a small request while the pages are read.
  let pinging = true;
  const pings = [];
  const pinger = (async () => { while (pinging) { pings.push((await timed(`${base}/api/sessions`)).ms); await sleep(10); } })();

  const conv = `${base}/api/terminals/big-thread/conversation`;
  const pages = [];
  const first = await timed(`${conv}?limit=200`);
  if (first.status !== 200 || first.body.items.length === 0) throw new Error('the first page is empty: ' + JSON.stringify(first.body).slice(0, 200));
  pages.push(first.ms);
  let before = first.body.startLine;
  let items = first.body.items.length;
  for (let i = 1; i < 50; i++) {
    const page = await timed(`${conv}?before=${before}&limit=200`);
    pages.push(page.ms);
    items += page.body.items.length;
    before = page.body.startLine;
  }
  pinging = false;
  await pinger;
  const during = await probe();
  await sleep(100);

  // A second window: an anchored page, a poll, and a search of the whole file.
  pinging = true;
  const pagePings = pings.splice(0);
  const pinger2 = (async () => { while (pinging) { pings.push((await timed(`${base}/api/sessions`)).ms); await sleep(10); } })();
  const anchor = await timed(`${conv}?beforeUuid=a-${made.turns - 150}&limit=200`);
  const poll = await timed(`${conv}?since=${first.body.cursor - 50}`);
  const search = await timed(`${conv}/search?q=${encodeURIComponent('Question 12:')}`);
  pinging = false;
  await pinger2;
  const duringSearch = await probe();

  console.log(JSON.stringify({
    label, dist, fileMb: Math.round(made.bytes / 1048576), lines: first.body.cursor,
    pageMs: { first: Math.round(pages[0] * 10) / 10, ...stats(pages) }, itemsRead: items,
    beforeUuidPageMs: Math.round(anchor.ms * 10) / 10, pollMs: Math.round(poll.ms * 10) / 10,
    searchMs: Math.round(search.ms * 10) / 10, searchMatches: search.body.matches?.length,
    sessionsLatencyDuringPagesMs: stats(pagePings), sessionsLatencyDuringSearchMs: stats(pings),
    daemonIdle: idle, daemonDuring50Pages: during, daemonDuringAnchorPollSearch: duringSearch,
  }, null, 2));
} finally {
  stop();
  fs.rmSync(transcript, { force: true });
}
