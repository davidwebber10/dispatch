// W3-B characterization: how SessionService registers a structured manager and what it does with the
// manager's events, recorded through the facade before the code moved to HarnessRegistry. The facade
// must do the same after the move.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messageSourceDb from '../../src/db/message-source.js';
import { SessionService } from '../../src/sessions/service.js';
import { KeyRegistry } from '../../src/auth/principals.js';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';

class FakeManager extends EventEmitter {
  isAlive() { return false; }
}

let tmp: string;
let home: string;
let db: Database.Database;
let svc: SessionService;
const proj = () => path.join(tmp, 'proj');
const cfg = (id: string) => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');

function writeTranscript(sessionId: string, lines: unknown[]) {
  const d = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(proj(), 'darwin'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-registry-char-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(proj(), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: proj() });
  for (const [id, type] of [['cc', 'claude-code'], ['cx', 'codex'], ['gk', 'grok']]) {
    terminalsDb.create(db, { id, sessionId: 's1', type, label: id, workingDir: proj(), config: { transport: 'structured' } });
  }
  svc = new SessionService(db, new EventEmitter() as any, path.join(tmp, 'mcp.json'));
});
afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SessionService structured manager registry (characterization)', () => {
  it('one manager per type: the same one again is a no-op, another throws, an unknown type throws', () => {
    const m = new FakeManager();
    svc.registerStructuredManager('codex', m as any);
    svc.setCodexStructuredManager(m as any);
    expect(() => svc.registerStructuredManager('codex', new FakeManager() as any)).toThrow('Structured manager already registered: codex');
    expect(() => svc.registerStructuredManager('nope', new FakeManager() as any)).toThrow();
    expect(svc.structuredManagerFor('codex')).toBe(m);
    expect(svc.structuredManagerFor('grok')).toBeUndefined();
    expect(svc.structuredManagerForTerminal('cx')).toBe(m);
    expect(svc.structuredManagerForTerminal('missing')).toBeUndefined();
    expect(m.listenerCount('session')).toBe(1); // the listeners are added once
  });

  it('the aliases register under their type', () => {
    const [a, b, c, d] = [new FakeManager(), new FakeManager(), new FakeManager(), new FakeManager()];
    svc.setStructuredManager(a as any);
    svc.setCodexStructuredManager(b as any);
    svc.setGrokStructuredManager(c as any);
    svc.setOpencodeStructuredManager(d as any);
    expect([svc.structuredManagerFor('claude-code'), svc.structuredManagerFor('codex'), svc.structuredManagerFor('grok'), svc.structuredManagerFor('opencode')]).toEqual([a, b, c, d]);
  });

  it('session: the first id is saved; a Grok id never changes; a Claude ghost id is replaced, a healthy one is kept', () => {
    const grok = new FakeManager();
    const claude = new FakeManager();
    svc.registerStructuredManager('grok', grok as any);
    svc.registerStructuredManager('claude-code', claude as any);
    grok.emit('session', 'gk', 'g-1');
    grok.emit('session', 'gk', 'g-2');
    grok.emit('session', 'cc', 'wrong-type');
    expect(terminalsDb.getById(db, 'gk')!.external_id).toBe('g-1');
    expect(terminalsDb.getById(db, 'cc')!.external_id).toBeNull();
    claude.emit('session', 'cc', 'ghost');
    claude.emit('session', 'cc', 'real');
    expect(terminalsDb.getById(db, 'cc')!.external_id).toBe('real'); // 'ghost' had no transcript
    writeTranscript('real', [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }]);
    claude.emit('session', 'cc', 'newer');
    expect(terminalsDb.getById(db, 'cc')!.external_id).toBe('real');
  });

  it('process-restarted: the new pid is saved; a pid of 0 is not', () => {
    const m = new FakeManager();
    svc.registerStructuredManager('codex', m as any);
    m.emit('process-restarted', 'cx', 4321);
    expect(terminalsDb.getById(db, 'cx')!.pid).toBe(4321);
    m.emit('process-restarted', 'cx', 0);
    expect(terminalsDb.getById(db, 'cx')!.pid).toBe(4321);
  });

  it('usage-limit parks the thread; idle, needs-help and failed end the turn for the limit service', () => {
    const calls: unknown[][] = [];
    svc.setUsageLimitService({ park: (...a: unknown[]) => calls.push(['park', ...a]), onTurnEnded: (id: string) => calls.push(['end', id]) } as any);
    const m = new FakeManager();
    svc.registerStructuredManager('codex', m as any);
    m.emit('usage-limit', 'cx', { kind: 'x' });
    for (const edge of ['idle', 'needs-help', 'failed']) m.emit(edge, 'cx');
    expect(calls).toEqual([['park', 'cx', 'codex', { kind: 'x' }], ['end', 'cx'], ['end', 'cx'], ['end', 'cx']]);
  });

  it('settings-refused puts the saved pick back', () => {
    const m = new FakeManager();
    svc.registerStructuredManager('codex', m as any);
    db.prepare("UPDATE terminals SET config = ? WHERE id = 'cx'").run(JSON.stringify({ transport: 'structured', model: 'gpt-x', effort: 'high' }));
    m.emit('settings-refused', 'cx', { model: 'gpt-x', effort: 'high', restoredModel: 'gpt-5' });
    expect(cfg('cx')).toMatchObject({ model: 'gpt-5' });
    expect(cfg('cx').effort).toBeUndefined();
  });

  it('Claude only: conversation-lost clears the stored id while it is still the lost one', () => {
    const claude = new FakeManager();
    const codex = new FakeManager();
    svc.registerStructuredManager('claude-code', claude as any);
    svc.registerStructuredManager('codex', codex as any);
    terminalsDb.updateExternalId(db, 'cc', 'gone');
    claude.emit('conversation-lost', 'cc', 'other');
    expect(terminalsDb.getById(db, 'cc')!.external_id).toBe('gone');
    claude.emit('conversation-lost', 'cc', 'gone');
    expect(terminalsDb.getById(db, 'cc')!.external_id).toBeNull();
    expect(cfg('cc').lostConversation.externalId).toBe('gone');
    expect(codex.listenerCount('conversation-lost')).toBe(0);
    expect(codex.listenerCount('message-source')).toBe(0);
  });

  it('Claude only: message-source saves the newest user line of the transcript that has no source yet', () => {
    const claude = new FakeManager();
    svc.registerStructuredManager('claude-code', claude as any);
    terminalsDb.updateExternalId(db, 'cc', 'sess');
    writeTranscript('sess', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    ]);
    claude.emit('message-source', 'cc', 'coordinator');
    expect([...messageSourceDb.listUuids(db, 'cc')]).toEqual(['u2']);
  });

  it('the exit of a structured process revokes its key, for a manager registered before or after the key registry', () => {
    const early = new FakeManager();
    svc.registerStructuredManager('claude-code', early as any);
    const reg = new KeyRegistry();
    svc.setKeyRegistry(reg, { keyDir: path.join(tmp, 'keys') });
    const late = new FakeManager();
    svc.registerStructuredManager('codex', late as any);
    expect(early.listenerCount('exit')).toBe(1);
    expect(late.listenerCount('exit')).toBe(1);
  });
});
