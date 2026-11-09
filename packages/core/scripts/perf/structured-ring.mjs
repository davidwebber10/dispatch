#!/usr/bin/env node
// Structured ring: memory and replay size with many streamed threads (plan section 1A.3, W2-D).
//
// Starts THREADS sessions on the built managers (dist/), each with a fake CLI that streams
// MESSAGES assistant messages of DELTAS deltas in one turn, and reports for each harness:
//   - the events and the JSON bytes that the rings hold (what a full replay sends),
//   - how many whole assistant messages the last 200 ring events carry (what a `tail=200` replay shows),
//   - the heap that the rings hold (heapUsed after a GC, less the heapUsed after the sessions end).
//
// Run it the same way on the wave base and on the branch:
//   pnpm -C packages/core build && node --expose-gc packages/core/scripts/perf/structured-ring.mjs
// Options (environment): THREADS=30 MESSAGES=200 DELTAS=40
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '../../dist/structured');
const { ClaudeStructuredSessionManager } = await import(path.join(dist, 'manager.js'));
const acpModule = fs.existsSync(path.join(dist, 'acp-manager.js')) ? 'acp-manager.js' : 'grok-manager.js';
const { GrokStructuredSessionManager } = await import(path.join(dist, acpModule));

const THREADS = Number(process.env.THREADS ?? 30);
const MESSAGES = Number(process.env.MESSAGES ?? 200);
const DELTAS = Number(process.env.DELTAS ?? 40);
const fakeClaude = path.join(here, '../../tests/structured/fake-claude-stream.mjs');

const ACP_AGENT = `
const readline = require('readline');
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const sessionId = 'sess-' + process.pid;
const WORDS = ['alpha ', 'bravo ', 'charlie ', 'delta ', 'echo ', 'foxtrot ', 'golf ', 'hotel '];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId, models: { currentModelId: 'grok-fake' } } });
  if (msg.method === 'session/prompt') {
    const [, messages, deltas] = /^STREAM (\\d+) (\\d+)$/.exec(msg.params.prompt[0].text).map(Number);
    for (let m = 0; m < messages; m++) {
      for (let i = 0; i < deltas; i++) notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: WORDS[(m + i) % WORDS.length] } }, _meta: { totalTokens: 9711, eventId: 'ev-' + i, promptId: 'p-1', updateType: 'AgentMessageChunk', chunkId: i } });
      if (m < messages - 1) {
        notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-' + m, title: 'run_terminal_command', kind: 'execute', status: 'pending', rawInput: { command: 'echo ' + m } } });
        notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-' + m, status: 'completed', rawOutput: { output: 'out ' + m } } });
      }
    }
    notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7 } } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-perf-'));
const acpAgent = path.join(tmp, 'acp-agent.cjs');
fs.writeFileSync(acpAgent, ACP_AGENT);

const gc = () => { if (!globalThis.gc) throw new Error('run with node --expose-gc'); for (let i = 0; i < 4; i++) globalThis.gc(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1024 / 1024).toFixed(1);

async function measure(name, manager, command, args) {
  const ids = Array.from({ length: THREADS }, (_, i) => `${name}-${i}`);
  let settled = 0;
  const onSettle = () => { settled += 1; };
  for (const ev of ['idle', 'needs-help', 'failed']) manager.on(ev, onSettle);
  for (const id of ids) manager.spawn(id, { command, args, workDir: tmp });
  await new Promise((resolve) => {
    const seen = new Set();
    manager.on('session', (id) => { seen.add(id); if (seen.size === THREADS) resolve(); });
  });
  const started = Date.now();
  for (const id of ids) manager.sendMessage(id, `STREAM ${MESSAGES} ${DELTAS}`);
  while (settled < THREADS) {
    if (Date.now() - started > 180_000) throw new Error(`${name}: only ${settled} of ${THREADS} turns ended`);
    await sleep(50);
  }
  await sleep(200);
  const turnMs = Date.now() - started;
  gc();
  const heapWith = process.memoryUsage().heapUsed;
  let events = 0; let bytes = 0; let tailMessages = 0; let tailText = 0; let kept = 0;
  for (const id of ids) {
    const ring = manager.getEvents(id);
    events += ring.length;
    for (const e of ring) bytes += JSON.stringify(e).length;
    // How much of the turn a full replay still shows: the text of the whole frames (Claude), else of the deltas.
    const wholeChars = ring.filter((e) => e?.type === 'assistant').flatMap((e) => e.message?.content ?? []).filter((b) => b?.type === 'text').reduce((n, b) => n + b.text.length, 0);
    const deltaChars = ring.filter((e) => e?.type === 'stream_event' && e.event?.delta?.type === 'text_delta').reduce((n, e) => n + e.event.delta.text.length, 0);
    kept += Math.max(wholeChars, deltaChars);
    const tail = manager.getEventsTail(id, 200);
    tailMessages += tail.filter((e) => e?.type === 'assistant' && e.message?.content?.some((b) => b.type === 'text')).length;
    tailText += tail.filter((e) => e?.type === 'stream_event' && e.event?.delta?.type === 'text_delta').reduce((n, e) => n + e.event.delta.text.length, 0);
  }
  manager.killAll();
  await sleep(300);
  gc();
  const heapWithout = process.memoryUsage().heapUsed;
  return {
    harness: name,
    'ring events (all threads)': events,
    'ring events per thread': Math.round(events / THREADS),
    'replay JSON MB (all threads)': mb(bytes),
    'heap held by the rings MB': mb(heapWith - heapWithout),
    'reply text a full replay shows, % of the turn': Math.round((100 * kept) / (THREADS * sentChars)),
    'whole text messages in a tail=200 replay (per thread)': Math.round(tailMessages / THREADS),
    'streamed text chars in a tail=200 replay (per thread)': Math.round(tailText / THREADS),
    'turn time ms': turnMs,
  };
}

const WORDS = ['alpha ', 'bravo ', 'charlie ', 'delta ', 'echo ', 'foxtrot ', 'golf ', 'hotel '];
let sentChars = 0;
for (let m = 0; m < MESSAGES; m++) for (let i = 0; i < DELTAS; i++) sentChars += WORDS[(m + i) % WORDS.length].length;
const rows = [];
rows.push(await measure('claude', new ClaudeStructuredSessionManager(), process.execPath, [fakeClaude]));
rows.push(await measure('acp', new GrokStructuredSessionManager('grok'), process.execPath, [acpAgent]));
console.log(`threads=${THREADS} messages=${MESSAGES} deltas=${DELTAS} node=${process.version}`);
console.table(rows);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
