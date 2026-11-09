// A Grok or OpenCode agent that never answers must not hold a thread's settings lock for ever (round 4, review item).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GrokStructuredSessionManager } from './grok-manager.js';

const FAKE = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const DIALECT = process.env.FAKE_DIALECT || 'grok';
const answerSession = (msg) => write({ jsonrpc: '2.0', id: msg.id, result: DIALECT === 'grok'
  ? { sessionId: 's1', models: { currentModelId: 'grok-4.7', availableModels: [] } }
  : { sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'openrouter/a/one', options: [] }] } });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') {
    if (process.env.FAKE_HANG === 'session') return; // never answers: the session never gets ready
    if (process.env.FAKE_SESSION_DELAY) return void setTimeout(() => answerSession(msg), Number(process.env.FAKE_SESSION_DELAY));
    return answerSession(msg);
  }
  if ((msg.method === 'session/set_model' || msg.method === 'session/set_config_option') && process.env.FAKE_HANG === 'model') return; // never answers the switch
  if (msg.method === 'session/set_model') return write({ jsonrpc: '2.0', id: msg.id, result: { _meta: { model: { Ok: msg.params.modelId } } } });
  if (msg.method === 'session/set_config_option') return write({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ id: 'model', currentValue: msg.params.value }] } });
});
`;
let dir: string; let script: string; const cleanups: Array<() => void> = [];
const setup = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-timeout-'));
  script = path.join(dir, 'fake-acp.cjs');
  fs.writeFileSync(script, FAKE);
};
afterEach(() => { for (const c of cleanups.splice(0)) c(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe.each(['grok', 'opencode'] as const)('%s setModel has a time limit', (dialect) => {
  it('an agent that never answers the switch is given up on, with a plain reason', async () => {
    setup();
    const m = new GrokStructuredSessionManager(dialect, { switchTimeoutMs: 200 });
    cleanups.push(() => m.killAll());
    m.spawn('g1', { command: process.execPath, args: [script], workDir: dir, env: { FAKE_DIALECT: dialect, FAKE_HANG: 'model' } } as any);
    await until(() => m.getModel('g1') !== undefined);
    const t0 = Date.now();
    await expect(m.setModel('g1', 'x')).rejects.toThrow(/did not answer .* in time/);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(m.getModel('g1')).toBe(dialect === 'grok' ? 'grok-4.7' : 'openrouter/a/one'); // unchanged
  });

  it('an agent that never gets ready is given up on too', async () => {
    setup();
    const m = new GrokStructuredSessionManager(dialect, { switchTimeoutMs: 200 });
    cleanups.push(() => m.killAll());
    m.spawn('g2', { command: process.execPath, args: [script], workDir: dir, env: { FAKE_DIALECT: dialect, FAKE_HANG: 'session' } } as any);
    const t0 = Date.now();
    await expect(m.setModel('g2', 'x')).rejects.toThrow(/not ready in time/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('one deadline for the whole switch: an agent that is slow to get ready AND silent is given up on after one budget, not two (round 5, item 6)', async () => {
    setup();
    const m = new GrokStructuredSessionManager(dialect, { switchTimeoutMs: 500 });
    cleanups.push(() => m.killAll());
    m.spawn('g4', { command: process.execPath, args: [script], workDir: dir, env: { FAKE_DIALECT: dialect, FAKE_HANG: 'model', FAKE_SESSION_DELAY: '300' } } as any);
    const t0 = Date.now();
    await expect(m.setModel('g4', 'x')).rejects.toThrow(/in time/);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(400);
    expect(took).toBeLessThan(700);   // two budgets in a row would be about 800 ms (300 ready + 500 answer)
  });

  it('the timeout says the change may still apply, like Claude\'s (round 5, item 6)', async () => {
    setup();
    const m = new GrokStructuredSessionManager(dialect, { switchTimeoutMs: 200 });
    cleanups.push(() => m.killAll());
    m.spawn('g5', { command: process.execPath, args: [script], workDir: dir, env: { FAKE_DIALECT: dialect, FAKE_HANG: 'model' } } as any);
    await until(() => m.getModel('g5') !== undefined);
    await expect(m.setModel('g5', 'x')).rejects.toThrow(/may still take it/);
  });

  it('a healthy agent still switches', async () => {
    setup();
    const m = new GrokStructuredSessionManager(dialect, { switchTimeoutMs: 2000 });
    cleanups.push(() => m.killAll());
    m.spawn('g3', { command: process.execPath, args: [script], workDir: dir, env: { FAKE_DIALECT: dialect } } as any);
    await until(() => m.getModel('g3') !== undefined);
    expect(await m.setModel('g3', 'grok-4.7-fast')).toBe('grok-4.7-fast');
  });
});

async function until(pred: () => boolean, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > timeoutMs) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
}
