// packages/core/src/structured/manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeQuestion } from '../status/question.js';
import { ClaudeStructuredSessionManager, turnTextsFromEvents } from './manager.js';

describe('looksLikeQuestion wiring contract', () => {
  it('is the backstop the manager uses for an undeclared question turn', () => {
    expect(looksLikeQuestion('Rewired the rail. Does that look right?')).toBe(true);
    expect(looksLikeQuestion('Rewired the rail. All tests pass.')).toBe(false);
  });
});

// The complete texts of the last turn, for the owner-decisions capture (decision cards, Unit 3).
describe('turnTextsFromEvents — the Claude ring', () => {
  const fixture = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/claude-stream.jsonl'), 'utf8',
  ).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const text = (t: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } });
  const result = { type: 'result', subtype: 'success', is_error: false };

  it('a real stream: every main-agent text of the turn, oldest first, in full', () => {
    const texts = turnTextsFromEvents(fixture);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("I'll create the file and then verify it exists.");
    expect(texts[1].startsWith('Done — `hello.txt` was created and verified.')).toBe(true);
  });

  it('only the last ended turn: it stops at the turn before, and a running turn is not read', () => {
    expect(turnTextsFromEvents([text('old report'), result, text('new report'), text('Done.'), result])).toEqual(['new report', 'Done.']);
    expect(turnTextsFromEvents([text('old report'), result, text('still running')])).toEqual(['old report']);
    expect(turnTextsFromEvents([text('no result yet')])).toEqual([]);
    expect(turnTextsFromEvents([])).toEqual([]);
  });

  it('a sub-agent\'s text (parent_tool_use_id set) is never the agent\'s own', () => {
    expect(turnTextsFromEvents([result, text('sub-agent report', 'toolu_01'), text('My report.'), result])).toEqual(['My report.']);
  });

  it('the manager reads its own ring, and null for a terminal it does not run', () => {
    expect(new ClaudeStructuredSessionManager().getTurnTexts('nope')).toBeNull();
  });
});

// SEC sweep SUS-2: stopping a thread must end a CLI that ignores SIGTERM.
describe('ClaudeStructuredSessionManager.kill — a CLI that ignores SIGTERM', () => {
  it('is killed outright after the grace period', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = fs;
    const dir = mkdtempSync(path.join((await import('node:os')).tmpdir(), 'kill-grace-'));
    const script = path.join(dir, 'stubborn-cli.js');
    writeFileSync(script, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init' }));\nsetInterval(() => {}, 1000);\n");
    chmodSync(script, 0o755);
    const { KILL_GRACE_MS } = await import('../platform/kill-grace.js');
    const mgr = new ClaudeStructuredSessionManager();
    const pid = mgr.spawn('stubborn', { command: process.execPath, args: [script], workDir: dir, env: {} } as any);
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await new Promise((r) => setTimeout(r, 400)); // let the child install its handler
      mgr.kill('stubborn');
      await new Promise((r) => setTimeout(r, 200));
      expect(alive()).toBe(true); // SIGTERM alone did not end it
      const end = Date.now() + KILL_GRACE_MS + 3000;
      while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});


// ---- The effort picker on a live Claude thread (slash menu) ----
describe('ClaudeStructuredSessionManager.setEffort', () => {
  const stub = `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type !== 'control_request') return;
  console.log(JSON.stringify({ type: 'stub', seen: m.request }));
  const id = m.request_id;
  if (m.request.subtype === 'apply_flag_settings' && m.request.settings.effortLevel === 'refused') {
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'effort refused' } }));
  } else if (m.request.subtype === 'apply_flag_settings' && m.request.settings.effortLevel === 'silent') {
    // never answers
  } else if (m.request.subtype === 'apply_flag_settings' && m.request.settings.effortLevel === 'die') {
    setTimeout(() => process.exit(0), 50); // the CLI ends by itself while the change is pending
  } else {
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: {} } }));
  }
});
`;
  async function boot() {
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-effort-'));
    const script = path.join(dir, 'stub-cli.js');
    fs.writeFileSync(script, stub);
    fs.chmodSync(script, 0o755);
    const mgr = new ClaudeStructuredSessionManager();
    const events: any[] = [];
    mgr.on('event', (_id: string, e: any) => events.push(e));
    mgr.spawn('t1', { command: process.execPath, args: [script], workDir: dir, env: {} } as any);
    return { mgr, events, done: () => { mgr.killAll(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it('writes apply_flag_settings {effortLevel} and resolves; the reply is not an event for the chat', async () => {
    const t = await boot();
    try {
      await t.mgr.setEffort('t1', 'high');
      expect(t.events.filter((e) => e.type === 'stub').map((e) => e.seen)).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }]);
      expect(t.events.some((e) => e.type === 'control_response')).toBe(false);
    } finally { t.done(); }
  });

  it('rejects with the CLI\'s own words when it refuses', async () => {
    const t = await boot();
    try { await expect(t.mgr.setEffort('t1', 'refused')).rejects.toThrow('effort refused'); } finally { t.done(); }
  });

  it('a thread that is killed before it answers rejects with "The thread stopped" (the service reads that as a stop, not a refusal)', async () => {
    const t = await boot();
    try {
      const p = t.mgr.setEffort('t1', 'silent');
      const caught = p.catch((e) => e.message);
      await new Promise((r) => setTimeout(r, 100));
      t.mgr.kill('t1');
      expect(await caught).toBe('The thread stopped');
    } finally { t.done(); }
  });

  it('a CLI that ends by itself while the change is pending rejects at once with "The thread stopped", not after the 15 s wait', async () => {
    const t = await boot();
    try {
      const t0 = Date.now();
      await expect(t.mgr.setEffort('t1', 'die')).rejects.toThrow('The thread stopped');
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally { t.done(); }
  });

  it('a CLI that does not answer in time is reported honestly: the change may still be taken', async () => {
    const t = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const caught = t.mgr.setEffort('t1', 'silent').catch((e) => e.message);
      await vi.advanceTimersByTimeAsync(15_001);
      const msg = await caught;
      expect(msg).toMatch(/did not answer the effort change in time/);
      expect(msg).toMatch(/may still take it/);
    } finally { vi.useRealTimers(); t.done(); }
  });

  it('fails when the thread is not running', async () => {
    await expect(new ClaudeStructuredSessionManager().setEffort('nope', 'high')).rejects.toThrow(/not running/);
  });

  it('postNotice puts a line in the replay ring and shows it to the viewers', async () => {
    const t = await boot();
    try {
      t.mgr.postNotice('t1', 'Could not change the model: nope');
      expect(t.events.some((e) => e.type === 'system' && e.subtype === 'settings_refused' && e.message === 'Could not change the model: nope')).toBe(true);
      expect(t.mgr.getEvents('t1').some((e: any) => e.subtype === 'settings_refused')).toBe(true);
    } finally { t.done(); }
  });
});
