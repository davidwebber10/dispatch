// The overseer message log (structured-recap spec, Unit 1): every message that reaches a
// coordinator is logged with its sender, at the one write point all structured sends share.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { SessionService } from '../../src/sessions/service.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

class FakePty extends EventEmitter {
  isAlive() { return false; }
  write() {}
  kill() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  sent: { id: string; content: unknown; source?: string }[] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); return 1; }
  sendMessage(id: string, content: unknown, source?: any) { this.sent.push({ id, content, source }); }
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let structured: FakeStructured;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-msglog-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: dir });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { transport: 'structured', role: 'coordinator' } });
  terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: 'worker', config: { transport: 'structured', role: 'agent', agentType: 'implementer' } });
  structured = new FakeStructured();
  structured.live.add('coord');
  structured.live.add('agent');
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
  svc.clock = () => Date.parse('2026-10-05T17:00:00.000Z');
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => messagesDb.listForTerminal(db, 'coord').map((m) => ({ source: m.source, text: m.text }));

describe('overseer message log', () => {
  it('logs a human send as user, a peer send as coordinator, and an untagged send as daemon', () => {
    svc.sendStructuredMessage('coord', 'hello', 'user');
    svc.sendStructuredMessage('coord', 'from a peer', 'coordinator');
    svc.sendStructuredMessage('coord', '✅ Your agent "worker" just finished a turn.');
    expect(log()).toEqual([
      { source: 'user', text: 'hello' },
      { source: 'coordinator', text: 'from a peer' },
      { source: 'daemon', text: '✅ Your agent "worker" just finished a turn.' },
    ]);
    expect(messagesDb.listForTerminal(db, 'coord')[0].sentAt).toBe('2026-10-05T17:00:00.000Z');
  });

  it('logs a canned card click as canned even though its source is user', () => {
    svc.sendThreadMessage('coord', '“Deploy” — got it.', 'user', 'canned');
    expect(log()).toEqual([{ source: 'canned', text: '“Deploy” — got it.' }]);
    expect(structured.sent[0].source).toBe('user'); // the badge tag is unchanged
  });

  it('joins text blocks and writes an image as [image]', () => {
    svc.sendStructuredMessage('coord', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      { type: 'text', text: 'look at this' },
    ], 'user');
    expect(log()).toEqual([{ source: 'user', text: '[image]\nlook at this' }]);
  });

  it('never logs a message to a thread that is not a coordinator', () => {
    svc.sendStructuredMessage('agent', 'do the task', 'coordinator');
    expect(messagesDb.listForTerminal(db, 'agent')).toEqual([]);
  });

  it('a failed log write is reported and does not block the send', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE coordinator_messages');
    expect(() => svc.sendStructuredMessage('coord', 'still delivered', 'user')).not.toThrow();
    expect(structured.sent.map((s) => s.content)).toEqual(['still delivered']);
    expect(err).toHaveBeenCalled();
  });
});
