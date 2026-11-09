// packages/core/src/structured/shared/contract.test.ts
//
// Characterization ("contract") tests for the three structured managers. Each test drives a REAL
// manager with a fake process and records every event the manager emits, in order. The recorded
// lists (the snapshot file beside this one) were written from the code BEFORE the W2-D refactor
// to the shared transport core, so they pin that the refactor changed no emitted event.
//
// Two groups:
//   1. The captured wire fixtures (codex-frames, grok-frames, opencode-frames) replayed by a
//      generic fake agent.
//   2. The scripted fakes in tests/structured (fake-claude.mjs, fake-codex-app-server.mjs) and an
//      ACP fake with a streamed turn.
//
// The ring is NOT part of the recorded list: W2-D changes what the ring keeps (delta compaction).
// The ring has its own assertions here ("the ring holds the final message").

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructuredSessionManager, type IStructuredManager } from '../manager.js';
import { CodexStructuredSessionManager } from '../codex-manager.js';
import { GrokStructuredSessionManager } from '../grok-manager.js';
import * as codexFx from '../codex-frames.fixture.js';
import * as grokFx from '../grok-frames.fixture.js';
import * as ocFx from '../opencode-frames.fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, '../../../tests/structured/fake-claude.mjs');
const FAKE_CODEX = path.join(here, '../../../tests/structured/fake-codex-app-server.mjs');

/**
 * A fake agent that replays a list of captured frames. It speaks enough JSON-RPC for both
 * dialects: `initialize`, then `thread/start` (Codex) or `session/new` (ACP), then on each
 * `turn/start` / `session/prompt` it writes the frames in order. A frame with an `id` is a
 * server request: the fake waits for the client's answer before it writes the next frame.
 */
const REPLAY_AGENT = `
const fs = require('fs');
const readline = require('readline');
const spec = JSON.parse(fs.readFileSync(process.env.REPLAY_SPEC, 'utf8'));
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let waiting = null;
function play(frames, done) {
  let i = 0;
  const step = () => {
    while (i < frames.length) {
      const f = frames[i++];
      write({ jsonrpc: '2.0', ...f });
      if (f.id !== undefined) { waiting = step; return; }
    }
    done();
  };
  step();
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === undefined && msg.id !== undefined) { const w = waiting; waiting = null; if (w) w(); return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'thread/start' || msg.method === 'session/new') return write({ jsonrpc: '2.0', id: msg.id, result: spec.startResult });
  if (msg.method === 'turn/start') { write({ jsonrpc: '2.0', id: msg.id, result: spec.turnResult }); return play(spec.frames, () => {}); }
  if (msg.method === 'session/prompt') return play(spec.frames, () => write({ jsonrpc: '2.0', id: msg.id, result: spec.promptResult }));
  if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`;

let tmp: string;
let replayAgent: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2d-contract-'));
  replayAgent = path.join(tmp, 'replay-agent.cjs');
  fs.writeFileSync(replayAgent, REPLAY_AGENT);
});

function specFile(name: string, spec: unknown): string {
  const p = path.join(tmp, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(spec));
  return p;
}

type Recorded = [name: string, ...args: unknown[]];

/** Values that differ from run to run are replaced, so the recorded list is stable. */
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (key, v) => {
    if (key === 'counterScope') return '<scope>';
    if (key === 'duration_ms' && typeof v === 'number') return '<ms>';
    if (key === 'argv' && Array.isArray(v)) return '<argv>';
    return v;
  }));
}

/** Record every emit of `m` for terminal `id`, in order. */
function record(m: EventEmitter, id: string): Recorded[] {
  const out: Recorded[] = [];
  const emit = m.emit.bind(m);
  m.emit = ((name: string, ...args: unknown[]) => {
    if (typeof name === 'string' && args[0] === id) {
      const rest = name === 'process-restarted' ? ['<pid>'] : args.slice(1);
      out.push([name, ...(normalize(rest) as unknown[])]);
    }
    return emit(name, ...args);
  }) as typeof m.emit;
  return out;
}

async function until(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 60)); // let trailing frames of the same burst land
}

const names = (rec: Recorded[]) => rec.map((r) => r[0]);
const count = (rec: Recorded[], ...settles: string[]) => rec.filter((r) => settles.includes(r[0])).length;
const has = (rec: Recorded[], name: string) => rec.some((r) => r[0] === name);
const ringText = (m: IStructuredManager, id: string) => JSON.stringify(m.getEvents(id));

const managers: IStructuredManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.killAll(); });
function track<T extends IStructuredManager>(m: T): T { managers.push(m); return m; }

// --- 1. captured wire fixtures -------------------------------------------------------------------

describe('codex-frames.fixture replayed through CodexStructuredSessionManager', () => {
  const frames = [
    codexFx.threadStarted, codexFx.turnStarted, codexFx.userMessageStarted, codexFx.agentMsgStarted,
    codexFx.agentMsgDelta1, codexFx.agentMsgDelta2, codexFx.agentMsgCompleted, codexFx.cmdStarted, codexFx.cmdCompleted,
    codexFx.fileChangeStarted, codexFx.fileChangeApproval, codexFx.fileChangeCompleted, codexFx.tokenUsage, codexFx.turnCompleted,
  ];
  const threadId = codexFx.threadStarted.params.thread.id;
  async function run() {
    const m = track(new CodexStructuredSessionManager());
    const rec = record(m, 't1');
    const spec = specFile('codex', { startResult: { thread: { id: threadId, turns: [] }, model: 'gpt-5.6-sol' }, turnResult: { turn: { id: codexFx.turnStarted.params.turn.id } }, frames });
    m.spawn('t1', { command: process.execPath, args: [replayAgent], workDir: tmp, env: { REPLAY_SPEC: spec } });
    await until(() => has(rec, 'session'), 'codex session');
    m.sendMessage('t1', 'make hello.txt');
    await until(() => count(rec, 'idle', 'needs-help', 'failed') > 0, 'codex settle');
    return { m, rec };
  }

  it('the turn opens once and settles once', async () => {
    const { rec } = await run();
    expect(count(rec, 'busy')).toBeGreaterThanOrEqual(1);
    expect(count(rec, 'idle', 'needs-help', 'failed', 'scheduled')).toBe(1);
    expect(names(rec).filter((n) => n === 'event').length).toBeGreaterThan(5);
  });

  it('the ring holds the final message', async () => {
    const { m } = await run();
    const finalText = (codexFx.agentMsgCompleted.params.item as { text: string }).text;
    expect(ringText(m, 't1')).toContain(JSON.stringify(finalText).slice(1, -1));
    expect((m.getEvents('t1') as any[]).some((e) => e.type === 'result')).toBe(true);
  });

  it('the emitted HarnessEvents equal the recorded list', async () => {
    const { rec } = await run();
    expect(rec).toMatchSnapshot();
  });
});

describe('grok-frames.fixture replayed through the ACP manager (grok dialect)', () => {
  const frames = [
    grokFx.userMsgChunkLive, grokFx.thoughtChunk, grokFx.agentMsgChunk1, grokFx.agentMsgChunk2, grokFx.toolCall,
    grokFx.toolCallUpdateProgress, grokFx.requestPermission, grokFx.toolCallUpdateCompleted, grokFx.responseCompleted, grokFx.turnCompleted,
  ];
  const sessionId = grokFx.agentMsgChunk1.params.sessionId;
  async function run() {
    const m = track(new GrokStructuredSessionManager('grok'));
    const rec = record(m, 't1');
    const spec = specFile('grok', { startResult: { sessionId, models: { currentModelId: 'grok-4.6' } }, promptResult: { stopReason: 'end_turn' }, frames });
    m.spawn('t1', { command: process.execPath, args: [replayAgent], workDir: tmp, env: { REPLAY_SPEC: spec } });
    await until(() => has(rec, 'session'), 'grok session');
    m.sendMessage('t1', 'run the probe');
    await until(() => count(rec, 'idle', 'needs-help', 'failed') > 0, 'grok settle');
    return { m, rec };
  }

  it('the turn opens once and settles once', async () => {
    const { rec } = await run();
    expect(count(rec, 'busy')).toBeGreaterThanOrEqual(1);
    expect(count(rec, 'idle', 'needs-help', 'failed', 'scheduled')).toBe(1);
  });

  it('the ring holds the final message', async () => {
    const { m } = await run();
    const events = m.getEvents('t1') as any[];
    const text = events.filter((e) => e.type === 'stream_event' && e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text).join('');
    expect(text).toBe('PROBE-OK');
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('the emitted HarnessEvents equal the recorded list', async () => {
    const { rec } = await run();
    expect(rec).toMatchSnapshot();
  });
});

describe('opencode-frames.fixture replayed through the ACP manager (opencode dialect)', () => {
  const frames = [ocFx.toolCall, ocFx.toolCallInProgress, ocFx.toolCallCompleted, ocFx.agentMessageChunk, ocFx.usageUpdate];
  async function run() {
    const m = track(new GrokStructuredSessionManager('opencode'));
    const rec = record(m, 't1');
    const spec = specFile('opencode', { startResult: ocFx.sessionNewResponse, promptResult: ocFx.promptResponse, frames });
    m.spawn('t1', { command: process.execPath, args: [replayAgent], workDir: tmp, env: { REPLAY_SPEC: spec } });
    await until(() => has(rec, 'session'), 'opencode session');
    m.sendMessage('t1', 'run the probe');
    await until(() => count(rec, 'idle', 'needs-help', 'failed') > 0, 'opencode settle');
    return { m, rec };
  }

  it('the turn opens once and settles once', async () => {
    const { rec } = await run();
    expect(count(rec, 'busy')).toBeGreaterThanOrEqual(1);
    expect(count(rec, 'idle', 'needs-help', 'failed', 'scheduled')).toBe(1);
  });

  it('the ring holds the final message', async () => {
    const { m } = await run();
    const events = m.getEvents('t1') as any[];
    const text = events.filter((e) => e.type === 'stream_event' && e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text).join('');
    expect(text).toBe('PROBE-DONE');
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('the emitted HarnessEvents equal the recorded list', async () => {
    const { rec } = await run();
    expect(rec).toMatchSnapshot();
  });
});

// --- 2. the scripted fakes -----------------------------------------------------------------------

describe('fake-claude.mjs through ClaudeStructuredSessionManager', () => {
  function start(opts: { escalate?: boolean } = {}) {
    const m = track(new ClaudeStructuredSessionManager());
    const rec = record(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [FAKE_CLAUDE], workDir: tmp, escalate: opts.escalate });
    return { m, rec };
  }
  const settled = (rec: Recorded[], n = 1) => count(rec, 'idle', 'needs-help', 'failed', 'scheduled') >= n;

  it('a plain turn: the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'claude session');
    m.sendMessage('t1', 'hello', 'coordinator');
    await until(() => settled(rec), 'claude settle');
    expect(count(rec, 'idle', 'needs-help', 'failed', 'scheduled')).toBe(1);
    expect(ringText(m, 't1')).toContain('echo:hello');
    expect(rec).toMatchSnapshot();
  });

  it('a closing question: the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'claude session');
    m.sendMessage('t1', 'Should I go on?');
    await until(() => settled(rec), 'claude settle');
    expect(rec).toMatchSnapshot();
  });

  it('a declared outcome (done, then blocked, then needs_you): the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'claude session');
    m.noteDeclaredStatus('t1', { state: 'done', summary: 'all done' });
    m.sendMessage('t1', 'one');
    await until(() => settled(rec, 1), 'settle 1');
    m.noteDeclaredStatus('t1', { state: 'blocked', summary: 'waiting', blocker: 'the other agent' });
    m.sendMessage('t1', 'two');
    await until(() => settled(rec, 2), 'settle 2');
    m.noteDeclaredStatus('t1', { state: 'needs_you', summary: 'pick', ask: 'A or B?' });
    m.sendMessage('t1', 'three');
    await until(() => settled(rec, 3), 'settle 3');
    expect(rec).toMatchSnapshot();
  });

  it('an auto-allowed tool, then a wake tool: the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'claude session');
    m.sendMessage('t1', 'TRIGGER_PERMISSION');
    await until(() => settled(rec, 1), 'settle 1');
    m.sendMessage('t1', 'TRIGGER_SCHEDULE');
    await until(() => settled(rec, 2), 'settle 2');
    expect(rec).toMatchSnapshot();
  });

  it('a supervised tool that is answered, and a question: the recorded list', async () => {
    const { m, rec } = start({ escalate: true });
    await until(() => has(rec, 'session'), 'claude session');
    m.sendMessage('t1', 'TRIGGER_PERMISSION');
    await until(() => has(rec, 'permission'), 'permission');
    m.answerPermission('t1', 'req-1', { behavior: 'allow' });
    await until(() => settled(rec, 1), 'settle 1');
    m.sendMessage('t1', 'TRIGGER_STALE_QUESTION');
    await until(() => settled(rec, 2), 'settle 2');
    expect(rec).toMatchSnapshot();
  });

  it('an error turn, a self-started turn, and a kill: the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'claude session');
    m.sendMessage('t1', 'TRIGGER_ERROR_PLAIN');
    await until(() => settled(rec, 1), 'settle 1');
    m.sendMessage('t1', 'TRIGGER_SELF_TURN');
    await until(() => settled(rec, 3), 'settle 3');
    m.kill('t1');
    await until(() => has(rec, 'exit'), 'exit');
    expect(rec).toMatchSnapshot();
  });
});

describe('fake-codex-app-server.mjs through CodexStructuredSessionManager', () => {
  function start(opts: Record<string, unknown> = {}) {
    const m = track(new CodexStructuredSessionManager());
    const rec = record(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [FAKE_CODEX], workDir: tmp, ...opts });
    return { m, rec };
  }
  const settled = (rec: Recorded[], n = 1) => count(rec, 'idle', 'needs-help', 'failed', 'scheduled') >= n;

  it('a streamed turn, then a closing question: the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'codex session');
    m.sendMessage('t1', 'stream please');
    await until(() => settled(rec, 1), 'settle 1');
    expect(ringText(m, 't1')).toContain('Hello world');
    m.sendMessage('t1', 'this needs a decision');
    await until(() => settled(rec, 2), 'settle 2');
    expect(count(rec, 'idle', 'needs-help', 'failed', 'scheduled')).toBe(2);
    expect(rec).toMatchSnapshot();
  });

  it('a declared outcome and a turn with no agent message: the recorded list', async () => {
    const { m, rec } = start();
    await until(() => has(rec, 'session'), 'codex session');
    m.noteDeclaredStatus('t1', { state: 'blocked', summary: 'waiting', blocker: 'the other agent' });
    m.sendMessage('t1', 'stream please');
    await until(() => settled(rec, 1), 'settle 1');
    m.noteDeclaredStatus('t1', { state: 'needs_you', summary: 'pick', ask: 'A or B?' });
    m.sendMessage('t1', 'no agent message');
    await until(() => settled(rec, 2), 'settle 2');
    expect(rec).toMatchSnapshot();
  });

  it('a supervised approval that is answered, and an auto-approved one: the recorded list', async () => {
    const { m, rec } = start({ escalate: true });
    await until(() => has(rec, 'session'), 'codex session');
    m.sendMessage('t1', 'approve the file');
    await until(() => has(rec, 'permission'), 'permission');
    const pending = m.getPending('t1')!;
    m.answerPermission('t1', pending.requestId, { behavior: 'allow' });
    await until(() => settled(rec, 1), 'settle 1');
    m.setEscalate('t1', false);
    m.sendMessage('t1', 'approve the file');
    await until(() => settled(rec, 2), 'settle 2');
    expect(rec).toMatchSnapshot();
  });

  it('a resume with a backfill, a model switch and a kill: the recorded list', async () => {
    const { m, rec } = start({ resumeId: 'thread-old-1' });
    await until(() => (m.getEvents('t1') as any[]).some((e) => e.type === 'assistant'), 'backfill');
    await m.setModel('t1', 'gpt-6-luna');
    m.sendMessage('t1', 'stream please');
    await until(() => settled(rec, 1), 'settle 1');
    m.kill('t1');
    expect(rec).toMatchSnapshot();
  });
});

describe('a scripted ACP agent through the ACP manager', () => {
  const ACP_AGENT = `
const readline = require('readline');
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const sessionId = 'sess-acp-1';
const chunk = (kind, text) => notify('session/update', { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } });
let turn = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId, models: { currentModelId: 'grok-4.6' } } });
  if (msg.method === 'session/load') {
    notify('session/update', { sessionId: msg.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } }, _meta: { isReplay: true } });
    notify('session/update', { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } }, _meta: { isReplay: true } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { models: { currentModelId: 'grok-4.6' } } });
  }
  if (msg.method === 'session/set_model') return write({ jsonrpc: '2.0', id: msg.id, result: { _meta: { model: { Ok: msg.params.modelId } } } });
  if (msg.method === 'session/prompt') {
    turn += 1;
    chunk('agent_thought_chunk', 'thinking ');
    chunk('agent_thought_chunk', 'hard');
    for (const w of ['one ', 'two ', 'three']) chunk('agent_message_chunk', w);
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-' + turn, title: 'run_terminal_command', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-' + turn, status: 'completed', rawOutput: { output: 'hi' } } });
    for (const w of ['done ', turn === 2 ? 'now. Shall I go on?' : 'now.']) chunk('agent_message_chunk', w);
    notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7 } } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
  let agent: string;
  beforeAll(() => { agent = path.join(tmp, 'acp-agent.cjs'); fs.writeFileSync(agent, ACP_AGENT); });
  const settled = (rec: Recorded[], n = 1) => count(rec, 'idle', 'needs-help', 'failed', 'scheduled') >= n;

  it('two streamed turns, a declared outcome, a model switch and a kill: the recorded list', async () => {
    const m = track(new GrokStructuredSessionManager('grok'));
    const rec = record(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [agent], workDir: tmp });
    await until(() => has(rec, 'session'), 'acp session');
    m.sendMessage('t1', 'first');
    await until(() => settled(rec, 1), 'settle 1');
    m.sendMessage('t1', 'second');
    await until(() => settled(rec, 2), 'settle 2');
    m.noteDeclaredStatus('t1', { state: 'done', summary: 'finished' });
    m.sendMessage('t1', 'third');
    await until(() => settled(rec, 3), 'settle 3');
    await m.setModel('t1', 'grok-4.7');
    const text = (m.getEvents('t1') as any[]).filter((e) => e.type === 'stream_event' && e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text).join('');
    expect(text).toBe('one two threedone now.one two threedone now. Shall I go on?one two threedone now.');
    m.kill('t1');
    expect(count(rec, 'idle', 'needs-help', 'failed', 'scheduled')).toBe(3);
    expect(rec).toMatchSnapshot();
  });

  it('a resume that replays history: the recorded list', async () => {
    const m = track(new GrokStructuredSessionManager('grok'));
    const rec = record(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [agent], workDir: tmp, resumeId: 'sess-acp-1' });
    await until(() => (m.getEvents('t1') as any[]).some((e) => e.type === 'result'), 'replay');
    m.sendMessage('t1', 'again');
    await until(() => settled(rec, 1), 'settle 1');
    expect(rec).toMatchSnapshot();
  });
});
