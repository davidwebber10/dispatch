// packages/core/src/structured/grok-manager.test.ts
//
// Drives GrokStructuredSessionManager against a FAKE `grok agent stdio` (a node script
// speaking just enough ACP), so the JSON-RPC plumbing — handshake, session/new vs
// session/load, prompt turns, permission answers, cancel — is tested without the real
// binary, network, or credentials.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GrokStructuredSessionManager } from './grok-manager.js';

const FAKE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const MODE = process.env.FAKE_MODE || 'new';
let sessionId = null;
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === 'session/new') {
    sessionId = 'sess-fake-1';
    return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId, models: { currentModelId: 'grok-4.6' } } });
  }
  if (msg.method === 'session/load') {
    sessionId = msg.params.sessionId;
    // Replay: a user turn, a whole agent message, and a turn boundary — all before the response.
    notify('session/update', { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } }, _meta: { isReplay: true } });
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } }, _meta: { isReplay: true } });
    notify('_x.ai/session/update', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } }, _meta: { isReplay: true } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { models: { currentModelId: 'grok-4.6' } } });
  }
  if (msg.method === 'session/prompt') {
    const finish = (stopReason) => write({ jsonrpc: '2.0', id: msg.id, result: { stopReason } });
    if (MODE === 'permission') {
      // Ask permission mid-turn; the answer decides how the turn ends.
      write({ jsonrpc: '2.0', id: 999, method: 'session/request_permission', params: {
        sessionId,
        toolCall: { toolCallId: 'call-1', title: 'run_terminal_command', kind: 'execute', rawInput: { command: 'echo hi' } },
        options: [
          { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      } });
      global.pendingFinish = finish;
      return;
    }
    if (MODE === 'silent') {
      // A turn that ends with NO turn_completed notification — the prompt response is the
      // only boundary signal. (Also what a cancel looks like.)
      notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } });
      return setTimeout(() => finish('cancelled'), 30);
    }
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from fake' } } });
    notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, apiDurationMs: 5 } } });
    return finish('end_turn');
  }
  if (msg.id !== undefined && msg.result?.outcome) {
    // The permission answer — echo which option was picked, end the turn, and resolve it.
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'picked:' + (msg.result.outcome.optionId || msg.result.outcome.outcome) } } });
    notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: {} } });
    if (global.pendingFinish) { global.pendingFinish('end_turn'); global.pendingFinish = null; }
    return;
  }
});
`;

let fakePath: string;
const managers: GrokStructuredSessionManager[] = [];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mgr-test-'));
  fakePath = path.join(dir, 'fake-grok-acp.cjs');
  fs.writeFileSync(fakePath, FAKE);
});

afterEach(() => {
  for (const m of managers.splice(0)) m.killAll();
});

function makeManager(): GrokStructuredSessionManager {
  const m = new GrokStructuredSessionManager();
  managers.push(m);
  return m;
}

function spawnOpts(extra: Record<string, unknown> = {}) {
  return {
    command: process.execPath,
    args: [fakePath],
    workDir: os.tmpdir(),
    ...extra,
  } as any;
}

const until = <T>(fn: (resolve: (v: T) => void) => void, ms = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    fn((v) => { clearTimeout(timer); resolve(v); });
  });

describe('GrokStructuredSessionManager', () => {
  it('spawn → handshake, session/new, a session emit, and an init event with the model', async () => {
    const m = makeManager();
    const sessionId = until<string>((resolve) => m.on('session', (_tid, sid) => resolve(sid)));
    m.spawn('t1', spawnOpts());
    expect(await sessionId).toBe('sess-fake-1');
    // The init event lands in the ring once the session is bound.
    await until<void>((resolve) => {
      const tick = () => (m.getEvents('t1').some((e: any) => e?.type === 'system' && e?.subtype === 'init') ? resolve() : setTimeout(tick, 10));
      tick();
    });
    const init: any = m.getEvents('t1').find((e: any) => e?.type === 'system' && e?.subtype === 'init');
    expect(init.model).toBe('grok-4.6');
  });

  it('sendMessage → user echo + busy, streamed events, then idle with the turn summary', async () => {
    const m = makeManager();
    m.spawn('t1', spawnOpts());
    const gotBusy = until<void>((resolve) => m.on('busy', () => resolve()));
    const idle = until<any>((resolve) => m.on('idle', (_tid, detail) => resolve(detail)));
    m.sendMessage('t1', 'hi there', 'user');
    await gotBusy;
    const detail = await idle;
    expect(detail.summary).toBe('hello from fake');
    const events = m.getEvents('t1') as any[];
    const echo = events.find((e) => e?.type === 'user' && e?.meta?.source === 'user');
    expect(echo.message.content[0].text).toBe('hi there');
    expect(events.some((e) => e?.type === 'result' && e?.subtype === 'grok_turn')).toBe(true);
  });

  it('a declared needs_you wins over the translator boundary at the turn end', async () => {
    const m = makeManager();
    m.spawn('t1', spawnOpts());
    const needsHelp = until<any>((resolve) => m.on('needs-help', (_tid, detail) => resolve(detail)));
    m.sendMessage('t1', 'hi');
    m.noteDeclaredStatus('t1', { state: 'needs_you', summary: 'pick a color', ask: 'Red or blue?' });
    const detail = await needsHelp;
    expect(detail).toMatchObject({ ask: 'Red or blue?', inferred: false });
  });

  it('resume (resumeId) → session/load; replay lands in the ring with NO idle/busy emitted', async () => {
    const m = makeManager();
    let boundaries = 0;
    m.on('idle', () => boundaries++);
    m.on('busy', () => boundaries++);
    const sessionEmit = until<string>((resolve) => m.on('session', (_tid, sid) => resolve(sid)));
    m.spawn('t1', spawnOpts({ resumeId: 'sess-resumed-9' }));
    expect(await sessionEmit).toBe('sess-resumed-9');
    await until<void>((resolve) => {
      const tick = () => (m.getEvents('t1').some((e: any) => e?.type === 'assistant') ? resolve() : setTimeout(tick, 10));
      tick();
    });
    const events = m.getEvents('t1') as any[];
    const user = events.find((e) => e?.type === 'user');
    expect(user.message.content[0].text).toBe('earlier question');
    const agent = events.find((e) => e?.type === 'assistant');
    expect(agent.message.content[0].text).toBe('earlier answer');
    // Replay writes no per-turn footers (no usage double-counting, no rendered cards)…
    expect(events.some((e) => e?.type === 'result' && e?.subtype !== 'backfill')).toBe(false);
    expect(boundaries).toBe(0);
    // …but it MUST end with the synthetic settle the client swallows: replayed whole
    // `assistant` events set the chat's busy=true, and with no result after them a revived
    // thread showed "Working…" forever (the same fix cc-sessions.ts applies for Claude).
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: 'result', subtype: 'backfill', is_error: false });
  });

  it('a turn with no turn_completed still settles when the prompt response lands', async () => {
    const m = makeManager();
    m.spawn('t1', spawnOpts({ env: { FAKE_MODE: 'silent' } }));
    const idle = until<any>((resolve) => m.on('idle', (_tid, detail) => resolve(detail)));
    m.sendMessage('t1', 'hi');
    const detail = await idle;
    expect(detail).toBeDefined(); // settled via the response fallback, not a notification
  });

  it('autonomous thread auto-answers a permission request with the allow option', async () => {
    const m = makeManager();
    m.spawn('t1', spawnOpts({ env: { FAKE_MODE: 'permission' }, escalate: false }));
    const idle = until<any>((resolve) => m.on('idle', () => resolve(m.getEvents('t1'))));
    m.sendMessage('t1', 'do it');
    const events = (await idle) as any[];
    // The fake echoes which option the answer picked.
    const picked = events.filter((e) => e?.type === 'stream_event').map((e) => e.event?.delta?.text ?? '').join('');
    expect(picked).toContain('picked:ok');
  });

  it('supervised thread surfaces the permission, and answerPermission(deny) picks reject', async () => {
    const m = makeManager();
    m.spawn('t1', spawnOpts({ env: { FAKE_MODE: 'permission' }, escalate: true }));
    const pending = until<any>((resolve) => m.on('permission', (_tid, p) => resolve(p)));
    m.sendMessage('t1', 'do it');
    const p = await pending;
    expect(p.toolName).toBe('run_terminal_command');
    expect(m.getPending('t1')?.requestId).toBe(p.requestId);
    const idle = until<any>((resolve) => m.on('idle', () => resolve(m.getEvents('t1'))));
    expect(m.answerPermission('t1', p.requestId, { behavior: 'deny', message: 'no' })).toBe(true);
    const events = (await idle) as any[];
    const picked = events.filter((e) => e?.type === 'stream_event').map((e) => e.event?.delta?.text ?? '').join('');
    expect(picked).toContain('picked:no');
    expect(m.getPending('t1')).toBeNull();
  });

  it('kill tears the session down and isAlive flips', async () => {
    const m = makeManager();
    m.spawn('t1', spawnOpts());
    expect(m.isAlive('t1')).toBe(true);
    m.kill('t1');
    expect(m.isAlive('t1')).toBe(false);
  });
});
