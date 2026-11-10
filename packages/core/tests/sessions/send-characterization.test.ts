// W3-B characterization: how SessionService sends a message to a thread, recorded through the facade
// before the code moved to ThreadMessages. The facade must do the same after the move.
// (src/sessions/send-thread-message.test.ts and tests/sessions/coordinator-message-log.test.ts cover more.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { SessionService } from '../../src/sessions/service.js';
import { ptyMessagePayload } from '../../src/sessions/pty-message.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  written: [string, string][] = [];
  isAlive(id: string) { return this.alive.has(id); }
  write(id: string, data: string) { this.written.push([id, data]); }
}
class FakeStructured extends EventEmitter {
  live = new Set<string>();
  sent: [string, unknown, unknown][] = [];
  spawnFails = false;
  isAlive(id: string) { return this.live.has(id); }
  sendMessage(id: string, content: unknown, source: unknown) { this.sent.push([id, content, source]); }
}

let db: Database.Database;
let pty: FakePty;
let mgr: FakeStructured;
let svc: SessionService;
let limitCalls: string[];

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/nowhere' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'c', config: { transport: 'structured', role: 'coordinator' } });
  terminalsDb.create(db, { id: 'pretty', sessionId: 's1', type: 'claude-code', label: 'p', config: { transport: 'structured' } });
  terminalsDb.create(db, { id: 'cli', sessionId: 's1', type: 'claude-code', label: 'cli' });
  pty = new FakePty();
  mgr = new FakeStructured();
  svc = new SessionService(db, pty as any, '/nowhere/mcp.json');
  svc.registerStructuredManager('claude-code', mgr as any);
  svc.clock = () => Date.parse('2026-11-09T10:00:00.000Z');
  limitCalls = [];
  svc.setUsageLimitService({ onUserMessage: (id: string) => limitCalls.push(id), onTurnEnded() {}, onStopped() {} } as any);
  // The start of a dead thread is the spawner's job; here it starts the fake process or fails.
  (svc as any).ensureStructuredAlive = (id: string) => { if (mgr.spawnFails) return false; mgr.live.add(id); return true; };
});
afterEach(() => { db.close(); });

describe('SessionService sendStructuredMessage (characterization)', () => {
  it('a dead thread is started through the facade ensureStructuredAlive, then the message goes to the manager', () => {
    svc.sendStructuredMessage('pretty', 'hi', 'user');
    expect(mgr.sent).toEqual([['pretty', 'hi', 'user']]);
  });

  it('a thread that cannot start: "no structured session for terminal"; a thread with no manager too', () => {
    mgr.spawnFails = true;
    expect(() => svc.sendStructuredMessage('pretty', 'hi')).toThrow('no structured session for terminal');
    expect(() => svc.sendStructuredMessage('missing', 'hi')).toThrow('no structured session for terminal');
  });

  it('a coordinator log row per send: user, coordinator, daemon by source, or the given logAs', () => {
    mgr.live.add('coord');
    svc.sendStructuredMessage('coord', 'a', 'user');
    svc.sendStructuredMessage('coord', 'b', 'coordinator');
    svc.sendStructuredMessage('coord', 'c');
    svc.sendStructuredMessage('coord', 'd', 'user', 'canned');
    svc.sendStructuredMessage('pretty', 'e', 'user'); // not a coordinator: no row
    expect(messagesDb.listForTerminal(db, 'coord').map((r) => [r.text, r.source, r.sentAt])).toEqual([
      ['a', 'user', '2026-11-09T10:00:00.000Z'],
      ['b', 'coordinator', '2026-11-09T10:00:00.000Z'],
      ['c', 'daemon', '2026-11-09T10:00:00.000Z'],
      ['d', 'canned', '2026-11-09T10:00:00.000Z'],
    ]);
  });

  it('only the owner\'s own message ends a usage-limit pause; the auto-resume send does not', () => {
    mgr.live.add('pretty');
    svc.sendStructuredMessage('pretty', 'x', 'coordinator');
    svc.sendStructuredMessage('pretty', 'x');
    expect(limitCalls).toEqual([]);
    svc.sendStructuredMessage('pretty', 'x', 'user');
    expect(limitCalls).toEqual(['pretty']);
    pty.alive.add('cli');
    svc.sendThreadMessage('cli', 'y', 'user');
    expect(limitCalls).toEqual(['pretty', 'cli']);
  });
});

describe('SessionService sendThreadMessage (characterization)', () => {
  it('a structured thread: the send of the facade, which a caller can replace', () => {
    const calls: unknown[][] = [];
    (svc as any).sendStructuredMessage = (...a: unknown[]) => { calls.push(a); };
    expect(svc.sendThreadMessage('pretty', 'hi', 'user', 'user')).toEqual({ transport: 'structured', droppedNonText: false, delivered: 'hi' });
    expect(calls).toEqual([['pretty', 'hi', 'user', 'user']]);
  });

  it('a CLI thread: one paste typed into the PTY; the sender line of another project goes first', () => {
    pty.alive.add('cli');
    const r = svc.sendThreadMessage('cli', 'hi', undefined, undefined, { terminalId: 'x1', name: 'Other', overseer: false, thread: 'w' } as any);
    expect(r.transport).toBe('pty');
    expect(String(r.delivered).endsWith('\n\nhi')).toBe(true);
    expect(pty.written).toEqual([['cli', ptyMessagePayload(String(r.delivered))]]);
  });
});
