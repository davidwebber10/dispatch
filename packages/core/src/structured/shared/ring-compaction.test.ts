// packages/core/src/structured/shared/ring-compaction.test.ts
//
// The ring of each REAL manager after a streamed turn: what a viewer that connects later gets.
// The live 'event' emits are not changed by compaction; contract.test.ts pins those.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructuredSessionManager, type IStructuredManager } from '../manager.js';
import { CodexStructuredSessionManager } from '../codex-manager.js';
import { AcpStructuredSessionManager } from '../acp-manager.js';
import { GrokStructuredSessionManager } from '../grok-manager.js';
import { DEFAULT_MAX_BYTES } from './event-ring.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_STREAM = path.join(here, '../../../tests/structured/fake-claude-stream.mjs');
const FAKE_CODEX = path.join(here, '../../../tests/structured/fake-codex-app-server.mjs');

const managers: IStructuredManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.killAll(); });
function track<T extends IStructuredManager>(m: T): T { managers.push(m); return m; }

function settle(m: IStructuredManager, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the turn did not settle')), 10_000);
    const done = (eid: string) => { if (eid === id) { clearTimeout(t); resolve(); } };
    m.on('idle', done); m.on('needs-help', done); m.on('failed', done);
  });
}
function session(m: IStructuredManager, id: string): Promise<void> {
  return new Promise((resolve) => { m.on('session', (eid: string) => { if (eid === id) resolve(); }); });
}
const kind = (e: any) => (e.type === 'stream_event' ? `stream:${e.event.type}` : e.type === 'system' ? `system:${e.subtype}` : e.type);
const deltas = (events: any[]) => events.filter((e) => e.type === 'stream_event' && e.event.type === 'content_block_delta');

describe('the Claude ring after a streamed turn', () => {
  it('holds each finished message as whole frames, and no delta', async () => {
    const m = track(new ClaudeStructuredSessionManager());
    const live: any[] = [];
    m.on('event', (_id, e) => live.push(e));
    const ready = session(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [FAKE_CLAUDE_STREAM], workDir: os.tmpdir() });
    await ready;
    const done = settle(m, 't1');
    m.sendMessage('t1', 'STREAM 3 20');
    await done;
    const ring = m.getEvents('t1') as any[];
    // The live viewers got every delta: 3 messages of 20 text deltas, and 2 tool-input deltas.
    expect(deltas(live)).toHaveLength(62);
    expect(deltas(ring)).toHaveLength(0);
    expect(ring.map(kind).filter((k) => k !== 'system:init')).toEqual([
      'user',
      'stream:message_start', 'assistant', 'assistant', 'user',
      'stream:message_start', 'assistant', 'assistant', 'user',
      'stream:message_start', 'assistant',
      'result',
    ]);
    const texts = ring.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b: any) => b.type === 'text').map((b: any) => b.text);
    expect(texts).toHaveLength(3);
    expect(texts[0].split(' ').filter(Boolean)).toHaveLength(20);
    expect(m.getTurnTexts('t1')).toEqual(texts.map((t: string) => t.trim()));
  });

  it('keeps the deltas of a message that is still in flight', async () => {
    const m = track(new ClaudeStructuredSessionManager());
    const ready = session(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [FAKE_CLAUDE_STREAM], workDir: os.tmpdir() });
    await ready;
    m.sendMessage('t1', 'HANG 5');
    const start = Date.now();
    while (deltas(m.getEvents('t1') as any[]).length < 5) {
      if (Date.now() - start > 8000) throw new Error('the open message did not stream');
      await new Promise((r) => setTimeout(r, 20));
    }
    const kinds = (m.getEvents('t1') as any[]).map(kind).filter((k) => k !== 'system:init');
    expect(kinds).toEqual([
      'user',
      'stream:message_start', 'assistant', // the first message is done: whole
      'stream:message_start', 'stream:content_block_start',
      'stream:content_block_delta', 'stream:content_block_delta', 'stream:content_block_delta', 'stream:content_block_delta', 'stream:content_block_delta',
    ]);
  });

  it('a seed over the byte limit keeps the newest history under 8 MB', () => {
    const m = track(new ClaudeStructuredSessionManager());
    const seedEvents = Array.from({ length: 20 }, (_, i) => ({ type: 'assistant', n: i, message: { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] } }));
    m.spawn('t1', { command: process.execPath, args: [FAKE_CLAUDE_STREAM], workDir: os.tmpdir(), seedEvents });
    const ring = m.getEvents('t1') as any[];
    const bytes = ring.reduce((n, e) => n + JSON.stringify(e).length, 0);
    expect(bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(ring).toHaveLength(7);
    expect(ring.at(-1).n).toBe(19);
    expect(m.lastFrameAt('t1')).toBeUndefined(); // history is not a sign of life
  });
});

describe('the Codex ring after a streamed turn', () => {
  it('holds the message as one delta, between its start and its stop with the final text', async () => {
    const m = track(new CodexStructuredSessionManager());
    const live: any[] = [];
    m.on('event', (_id, e) => live.push(e));
    const ready = session(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [FAKE_CODEX], workDir: os.tmpdir() });
    await ready;
    const done = settle(m, 't1');
    m.sendMessage('t1', 'stream please');
    await done;
    expect(deltas(live).map((e) => e.event.delta.text)).toEqual(['Hello ', 'world']);
    const ring = m.getEvents('t1') as any[];
    expect(deltas(ring).map((e) => e.event.delta.text)).toEqual(['Hello world']);
    const stream = ring.filter((e) => e.type === 'stream_event').map((e) => e.event.type);
    expect(stream).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop']);
    expect(ring.find((e) => e.event?.type === 'content_block_stop').event.final_text).toBe('Hello world');
  });
});

describe('the ACP ring after a streamed turn', () => {
  const AGENT = `
const readline = require('readline');
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const sessionId = 'sess-acp-ring';
const chunk = (kind, text) => notify('session/update', { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId, models: { currentModelId: 'grok-4.6' } } });
  if (msg.method === 'session/prompt') {
    for (const w of ['let ', 'me ', 'think']) chunk('agent_thought_chunk', w);
    for (let i = 0; i < 50; i++) chunk('agent_message_chunk', 'w' + i + ' ');
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { output: 'hi' } } });
    for (const w of ['all ', 'done.']) chunk('agent_message_chunk', w);
    notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7 } } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
  let agent: string;
  beforeAll(() => {
    agent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w2d-ring-')), 'acp-agent.cjs');
    fs.writeFileSync(agent, AGENT);
  });

  it('holds each closed block as one delta with the whole text; the grammar stays', async () => {
    const m = track(new AcpStructuredSessionManager('grok'));
    const live: any[] = [];
    m.on('event', (_id, e) => live.push(e));
    const ready = session(m, 't1');
    m.spawn('t1', { command: process.execPath, args: [agent], workDir: os.tmpdir() });
    await ready;
    const done = settle(m, 't1');
    m.sendMessage('t1', 'go');
    await done;
    expect(deltas(live)).toHaveLength(55);
    const ring = m.getEvents('t1') as any[];
    const words = Array.from({ length: 50 }, (_, i) => `w${i} `).join('');
    expect(deltas(ring).map((e) => e.event.delta)).toEqual([
      { type: 'thinking_delta', thinking: 'let me think' },
      { type: 'text_delta', text: words },
      { type: 'text_delta', text: 'all done.' },
    ]);
    // Each block is still start, delta, stop: the chat reducer renders it the same way.
    const stream = ring.filter((e) => e.type === 'stream_event').map((e) => `${e.event.type}${e.event.index ?? ''}`);
    expect(stream).toEqual([
      'message_start',
      'content_block_start0', 'content_block_delta0', 'content_block_stop0',
      'content_block_start1', 'content_block_delta1', 'content_block_stop1',
      'content_block_start2', 'content_block_delta2', 'content_block_stop2',
    ]);
    expect(m.getTurnTexts('t1')?.map((t) => t.trim())).toEqual([words.trim(), 'all done.']);
  });

  it('the old class name and the old module path still give the same class', () => {
    expect(GrokStructuredSessionManager).toBe(AcpStructuredSessionManager);
    expect(new GrokStructuredSessionManager('opencode')).toBeInstanceOf(AcpStructuredSessionManager);
  });
});
