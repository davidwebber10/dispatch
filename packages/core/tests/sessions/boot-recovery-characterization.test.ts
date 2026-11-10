// W3-B characterization: the boot kickstart and the shutdown that keeps interrupted turns, recorded
// through the SessionService facade before the code moved to BootRecovery. The facade must do the
// same after the move.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';

const CONTINUE_PROMPT =
  '⚙️ Dispatch restarted and interrupted you mid-task — re-read your last steps above and continue your ' +
  'mission from where you left off. If you had already finished, briefly say so instead of redoing work.';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  kill() {}
  killAll() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter {
  live = new Set<string>();
  spawns: string[] = [];
  sent: [string, unknown, unknown][] = [];
  failSpawn = false;
  setDefaultEnv() {}
  spawn(id: string) { if (this.failSpawn) throw new Error('no claude'); this.live.add(id); this.spawns.push(id); return 50; }
  sendMessage(id: string, content: unknown, source: unknown) { this.sent.push([id, content, source]); }
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { for (const id of [...this.live]) this.kill(id); }
}

let tmp: string;
let home: string;
let db: Database.Database;
let svc: SessionService;
let claude: FakeStructured;
const proj = () => path.join(tmp, 'proj');

function seed(id: string, config: Record<string, unknown>, opts: { type?: string; status?: string; externalId?: string } = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: opts.type ?? 'claude-code', label: id, workingDir: proj(), externalId: opts.externalId, config });
  terminalsDb.updateStatus(db, id, opts.status ?? 'working');
}
const cfg = (id: string) => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');

function writeTranscript(sessionId: string, lastIsCompleteAnswer: boolean) {
  const d = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(proj(), 'darwin'));
  fs.mkdirSync(d, { recursive: true });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    lastIsCompleteAnswer
      ? { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
      : { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
  ];
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-boot-char-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(proj(), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: proj() });
  svc = new SessionService(db, new FakePty() as any, path.join(tmp, 'data', 'mcp.json'));
  claude = new FakeStructured();
  svc.setStructuredCommandOverride({ command: 'fake', args: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SessionService boot kickstart (characterization)', () => {
  it('with no Claude and no Codex manager: nothing is read, nothing is kicked, and the answer comes at once', async () => {
    seed('c', { transport: 'structured', role: 'coordinator' });
    vi.useFakeTimers();
    const result = await svc.kickstartInterruptedAgents(); // the default settle is never waited for
    expect(result).toEqual({ kicked: [], skipped: [], completed: [] });
    expect(terminalsDb.getById(db, 'c')!.status).toBe('working');
  });

  it('waits the default settle of 4 s before it reads the rows', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    vi.useFakeTimers();
    let done = false;
    const p = svc.kickstartInterruptedAgents().then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(done).toBe(false);
    seed('c', { transport: 'structured', role: 'coordinator' }); // a row written during the settle is read
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).kicked).toEqual(['c']);
  });

  it('kicks a working coordinator and agent with the fixed prompt, stamps kickedAt, and skips every other row', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    seed('coord', { transport: 'structured', role: 'coordinator' });
    seed('agent', { transport: 'structured', role: 'agent' });
    seed('plain', { transport: 'structured' });                    // not an overseer thread
    seed('cli', { role: 'agent' });                                // the CLI transport
    seed('idle', { transport: 'structured', role: 'agent' }, { status: 'waiting' }); // not left working
    seed('cx', { transport: 'structured', role: 'agent' }, { type: 'codex' }); // Codex has no manager here
    terminalsDb.create(db, { id: 'bad', sessionId: 's1', type: 'claude-code', label: 'bad', workingDir: proj() });
    db.prepare("UPDATE terminals SET config = '{not json', status = 'working' WHERE id = 'bad'").run();

    const before = Date.now();
    const result = await svc.kickstartInterruptedAgents(0);

    expect(result.kicked.sort()).toEqual(['agent', 'coord']);
    expect(result.skipped.sort()).toEqual(['bad', 'cli', 'cx', 'plain']);
    expect(result.completed).toEqual([]);
    expect(claude.sent.map(([id, text, source]) => [id, text, source]).sort()).toEqual([
      ['agent', CONTINUE_PROMPT, undefined],
      ['coord', CONTINUE_PROMPT, undefined],
    ]);
    expect(Date.parse(cfg('coord').kickedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(cfg('plain').kickedAt).toBeUndefined();
  });

  it('the kick goes through the facade sendStructuredMessage, so a caller that replaces it is reached', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    seed('coord', { transport: 'structured', role: 'coordinator' });
    const calls: unknown[][] = [];
    (svc as any).sendStructuredMessage = (...args: unknown[]) => { calls.push(args); };
    const result = await svc.kickstartInterruptedAgents(0);
    expect(calls).toEqual([['coord', CONTINUE_PROMPT]]);
    expect(result.kicked).toEqual(['coord']);
  });

  it('a send that fails puts the row in skipped and stamps nothing', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    claude.failSpawn = true;
    seed('coord', { transport: 'structured', role: 'coordinator' });
    const result = await svc.kickstartInterruptedAgents(0);
    expect(result).toEqual({ kicked: [], skipped: ['coord'], completed: [] });
    expect(cfg('coord').kickedAt).toBeUndefined();
  });

  it('a transcript that shows a completed turn: skipped and named in completed', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    writeTranscript('sess-done', true);
    seed('coord', { transport: 'structured', role: 'coordinator' }, { externalId: 'sess-done' });
    const result = await svc.kickstartInterruptedAgents(0);
    expect(result).toEqual({ kicked: [], skipped: ['coord'], completed: ['coord'] });
    expect(claude.sent).toEqual([]);
  });

  it('kicked on a prior boot with no transcript activity since: skipped, not completed', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    writeTranscript('sess-cut', false);
    seed('coord', { transport: 'structured', role: 'coordinator', kickedAt: new Date(Date.now() + 60_000).toISOString() }, { externalId: 'sess-cut' });
    const result = await svc.kickstartInterruptedAgents(0);
    expect(result).toEqual({ kicked: [], skipped: ['coord'], completed: [] });
  });

  it('the interruptedAt stamp is consumed on this boot, whether the row is kicked or skipped', async () => {
    svc.registerStructuredManager('claude-code', claude as any);
    writeTranscript('sess-done', true);
    seed('kick', { transport: 'structured', role: 'agent', interruptedAt: '2026-11-09T00:00:00.000Z' });
    seed('skip', { transport: 'structured', role: 'agent', interruptedAt: '2026-11-09T00:00:00.000Z' }, { externalId: 'sess-done' });
    const result = await svc.kickstartInterruptedAgents(0);
    expect(result.kicked).toEqual(['kick']);
    expect(result.completed).toEqual(['skip']);
    expect('interruptedAt' in cfg('kick')).toBe(false);
    expect('interruptedAt' in cfg('skip')).toBe(false);
  });
});

describe('SessionService shutdown that keeps interrupted turns (characterization)', () => {
  it('runs stopAll once, writes working back and stamps interruptedAt on the overseer threads only, and returns their ids', () => {
    svc.registerStructuredManager('claude-code', claude as any);
    seed('coord', { transport: 'structured', role: 'coordinator' });
    seed('plain', { transport: 'structured' });
    seed('idle', { transport: 'structured', role: 'agent' }, { status: 'waiting' });
    let stops = 0;
    const restored = svc.shutdownPreservingInterruptedTurns(() => {
      stops++;
      // The exits settle every row, as the status service does in the daemon.
      for (const id of ['coord', 'plain']) terminalsDb.updateStatus(db, id, 'waiting');
    });
    expect(stops).toBe(1);
    expect(restored).toEqual(['coord']);
    expect(terminalsDb.getById(db, 'coord')!.status).toBe('working');
    expect(terminalsDb.getById(db, 'plain')!.status).toBe('waiting');
    expect(typeof cfg('coord').interruptedAt).toBe('string');
    expect(cfg('plain').interruptedAt).toBeUndefined();
  });

  it('the list is taken before stopAll: a row that stopAll settles is still restored', () => {
    seed('agent', { transport: 'structured', role: 'agent' });
    const restored = svc.shutdownPreservingInterruptedTurns(() => terminalsDb.updateStatus(db, 'agent', 'idle'));
    expect(restored).toEqual(['agent']);
    expect(terminalsDb.getById(db, 'agent')!.status).toBe('working');
  });
});
