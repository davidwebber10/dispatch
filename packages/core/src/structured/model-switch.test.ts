// packages/core/src/structured/model-switch.test.ts
//
// The active model of a Pretty thread, and a model switch without a restart, per harness:
//   Claude  — stream-json `control_request {subtype:'set_model'}` (live-verified on Claude Code 2.1.319:
//             the CLI answers `{response:{model:'claude-haiku-5-5'}}` and the next turn runs on it).
//   Codex   — `turn/start { model }` ("Override the model for this turn and subsequent turns").
//   Grok    — ACP `session/set_model { modelId }` (live-verified on grok 1.0.4).
//   OpenCode— ACP `session/set_config_option { configId:'model', value }` (live-verified on 1.18.34).
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructuredSessionManager } from './manager.js';
import { CodexStructuredSessionManager } from './codex-manager.js';
import { GrokStructuredSessionManager } from './grok-manager.js';

const FAKE_CLAUDE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let model = process.env.FAKE_MODEL || 'claude-opus-5-5';
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request' && msg.request.subtype === 'set_model') {
    if (msg.request.model === 'bogus') return write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'Unknown model bogus' } });
    model = msg.request.model === 'haiku' ? 'claude-haiku-5-5' : msg.request.model;
    return write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { model } } });
  }
  if (msg.type === 'user') {
    write({ type: 'system', subtype: 'init', session_id: 'sid-1', model });
    write({ type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'sub' }] } });
    write({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'text', text: 'ok' }] } });
    write({ type: 'result', subtype: 'success', is_error: false });
  }
});
`;

const FAKE_ACP = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const DIALECT = process.env.FAKE_DIALECT || 'grok';
const log = (o) => process.env.FAKE_LOG && require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  log({ method: msg.method, params: msg.params });
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') {
    const result = DIALECT === 'grok'
      ? { sessionId: 's1', models: { currentModelId: 'grok-4.7', availableModels: [] } }
      : { sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'openrouter/a/one', options: [] }] };
    return write({ jsonrpc: '2.0', id: msg.id, result });
  }
  if (msg.method === 'session/set_model') {
    if (msg.params.modelId === 'bogus') return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown model' } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { _meta: { model: { Ok: msg.params.modelId } } } });
  }
  if (msg.method === 'session/set_config_option') {
    return write({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ id: 'model', currentValue: msg.params.value, options: [] }] } });
  }
});
`;

let dir: string;
let claudePath: string;
let acpPath: string;
const codexFake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'structured', 'fake-codex-app-server.mjs');
const cleanups: Array<() => void> = [];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-switch-'));
  claudePath = path.join(dir, 'fake-claude.cjs');
  acpPath = path.join(dir, 'fake-acp.cjs');
  fs.writeFileSync(claudePath, FAKE_CLAUDE);
  fs.writeFileSync(acpPath, FAKE_ACP);
});
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function waitFor(m: any, id: string, pred: (e: any) => boolean, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const hit = m.getEvents(id).find(pred);
    if (hit) return resolve(hit);
    const t = setTimeout(() => { m.off('event', on); reject(new Error('timeout')); }, ms);
    const on = (eid: string, e: any) => { if (eid === id && pred(e)) { clearTimeout(t); m.off('event', on); resolve(e); } };
    m.on('event', on);
  });
}
const readLog = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const isNotice = (e: any) => e?.type === 'system' && e.subtype === 'model' && e.switched === true;

describe('Claude Pretty: the active model and a live switch', () => {
  function make() {
    const m = new ClaudeStructuredSessionManager();
    cleanups.push(() => m.killAll());
    m.spawn('c1', { command: process.execPath, args: [claudePath], workDir: dir });
    return m;
  }

  it('knows no model before the first frame, then the lead model from init and assistant frames (not a sub-agent)', async () => {
    const m = make();
    expect(m.getModel('c1')).toBeUndefined();
    m.sendMessage('c1', 'hi');
    await waitFor(m, 'c1', (e) => e.type === 'result');
    expect(m.getModel('c1')).toBe('claude-opus-5-5');
  });

  it('set_model switches the running process, records a notice in the ring, and reports the resolved id', async () => {
    const m = make();
    const resolved = await m.setModel('c1', 'haiku');
    expect(resolved).toBe('claude-haiku-5-5');
    expect(m.getModel('c1')).toBe('claude-haiku-5-5');
    const notice = m.getEvents('c1').find(isNotice) as any;
    expect(notice).toMatchObject({ model: 'claude-haiku-5-5' });
    m.sendMessage('c1', 'next');
    await waitFor(m, 'c1', (e) => e.type === 'assistant' && e.parent_tool_use_id == null);
    expect(m.getModel('c1')).toBe('claude-haiku-5-5');
  });

  it('a refused set_model rejects and leaves the model alone', async () => {
    const m = make();
    await expect(m.setModel('c1', 'bogus')).rejects.toThrow(/Unknown model/);
    expect(m.getEvents('c1').some(isNotice)).toBe(false);
  });
});

describe('Codex Pretty: a switch rides the next turn/start', () => {
  it('reports the bound model, and the next turn/start carries the new model', async () => {
    const logPath = path.join(dir, `codex-${Date.now()}.ndjson`);
    const m = new CodexStructuredSessionManager();
    cleanups.push(() => m.killAll());
    m.spawn('x1', { command: process.execPath, args: [codexFake], workDir: process.cwd(), model: 'gpt-5.6-sol', env: { CODEX_FAKE_LOG: logPath } });
    await waitFor(m, 'x1', (e) => e.type === 'system' && e.subtype === 'init');
    expect(m.getModel('x1')).toBe('gpt-5.6-sol');
    expect(await m.setModel('x1', 'gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(m.getModel('x1')).toBe('gpt-5.6-luna');
    expect(m.getEvents('x1').some(isNotice)).toBe(true);
    m.sendMessage('x1', 'hello');
    const start = await (async () => {
      for (let i = 0; i < 200; i++) {
        const hit = readLog(logPath).find((e) => e.method === 'turn/start');
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no turn/start');
    })();
    expect(start.params.model).toBe('gpt-5.6-luna');
  });
});

describe('ACP Pretty: Grok session/set_model, OpenCode session/set_config_option', () => {
  for (const dialect of ['grok', 'opencode'] as const) {
    it(`${dialect}: switches the live session and reports it`, async () => {
      const logPath = path.join(dir, `acp-${dialect}-${Date.now()}.ndjson`);
      const m = new GrokStructuredSessionManager(dialect);
      cleanups.push(() => m.killAll());
      m.spawn('g1', { command: process.execPath, args: [acpPath], workDir: dir, env: { FAKE_DIALECT: dialect, FAKE_LOG: logPath } } as any);
      await waitFor(m, 'g1', (e) => e.type === 'system' && e.subtype === 'init');
      expect(m.getModel('g1')).toBe(dialect === 'grok' ? 'grok-4.7' : 'openrouter/a/one');
      const target = dialect === 'grok' ? 'grok-4.7-build-fast' : 'openrouter/b/two';
      expect(await m.setModel('g1', target)).toBe(target);
      expect(m.getModel('g1')).toBe(target);
      expect(m.getEvents('g1').some(isNotice)).toBe(true);
      const sent = readLog(logPath).find((e) => e.method === (dialect === 'grok' ? 'session/set_model' : 'session/set_config_option'));
      expect(sent?.params).toMatchObject(dialect === 'grok' ? { sessionId: 's1', modelId: target } : { sessionId: 's1', configId: 'model', value: target });
    });
  }

  it('a refused set_model rejects', async () => {
    const m = new GrokStructuredSessionManager('grok');
    cleanups.push(() => m.killAll());
    m.spawn('g2', { command: process.execPath, args: [acpPath], workDir: dir, env: { FAKE_DIALECT: 'grok' } } as any);
    await waitFor(m, 'g2', (e) => e.type === 'system' && e.subtype === 'init');
    await expect(m.setModel('g2', 'bogus')).rejects.toThrow(/unknown model/);
    expect(m.getModel('g2')).toBe('grok-4.7');
  });
});
