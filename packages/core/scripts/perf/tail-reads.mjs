// Perf check for W1-E item 3 (plan section 1A.3, "Tail reads").
// Times findNewestUnresolvedUserUuid, readSessionBackfill and readTerminalTokenUsage on a synthetic
// transcript of about 16 MB. Each function runs 20 times. Reads the built code in ../../dist.
// Run:  node packages/core/scripts/perf/tail-reads.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeSyntheticTranscript } from './synthetic-transcript.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w1e-tail-'));
process.env.HOME = home; // before the import: the transcript path comes from os.homedir()
const cc = await import('../../dist/sessions/cc-sessions.js');

const workDir = '/tmp/w1e-perf';
const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'perf-session.jsonl');
const BYTES = Number(process.env.PERF_BYTES ?? 15.9 * 1024 * 1024); // just under the 16 MB backfill cap
const made = writeSyntheticTranscript(file, BYTES);

function time(name, fn, runs = 20) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  const times = [];
  let result;
  h.enable();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = fn(i);
    times.push(performance.now() - t0);
  }
  h.disable();
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { name, runs, meanMs: +mean.toFixed(2), medianMs: +times[times.length >> 1].toFixed(2), maxMs: +times[times.length - 1].toFixed(2), result };
}

const out = [];
const a = time('findNewestUnresolvedUserUuid', () => cc.findNewestUnresolvedUserUuid(workDir, 'perf-session', new Set()));
out.push({ ...a, result: a.result });
const b = time('readSessionBackfill', () => cc.readSessionBackfill(workDir, 'perf-session'));
out.push({ ...b, result: `${b.result.length} events` });
const c = time('readTerminalTokenUsage (file not changed)', () => cc.readTerminalTokenUsage(workDir, 'perf-session'));
out.push({ ...c, result: `${c.result?.totalTokens} tokens, ${c.result?.messageCount} messages` });
// The real pattern: one assistant line is added, then the totals are read again.
const d = time('readTerminalTokenUsage (one line added before each read)', (i) => {
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: `x-${i}`, message: { id: `x-${i}`, role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'more' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } }) + '\n');
  return cc.readTerminalTokenUsage(workDir, 'perf-session');
});
out.push({ ...d, result: `${d.result?.totalTokens} tokens, ${d.result?.messageCount} messages` });

console.log(JSON.stringify({ fileBytes: made.bytes, turns: made.turns, results: out }, null, 2));
fs.rmSync(home, { recursive: true, force: true });
