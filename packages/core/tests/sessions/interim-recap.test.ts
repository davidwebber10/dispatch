// Interim recap after 20 minutes (structured-recap spec, Unit 5), with an injectable clock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { formatInterimNotice, interimRecapTick, nextInterimConfig, startInterimRecapLoop, INTERIM_RECAP_MS } from '../../src/sessions/interim-recap.js';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

const T0 = Date.parse('2026-10-05T16:00:00.000Z');
const DUE = new Date(T0 + INTERIM_RECAP_MS).toISOString();
let dir: string;
let dbPath: string;

function open(): { db: Database.Database; svc: SessionService; sent: ReturnType<typeof vi.fn> } {
  const db = createDatabase(dbPath);
  const svc = new SessionService(db, new NoopPty(), path.join(dir, 'mcp.json'));
  vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;
  svc.clock = () => T0;
  return { db, svc, sent };
}
const due = (db: Database.Database) => JSON.parse(terminalsDb.getById(db, 'coord')!.config!).interimDueAt;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-interim-'));
  dbPath = path.join(dir, 'dispatch.db');
  const db = createDatabase(dbPath);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: dir });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'A', config: { role: 'agent' } });
  terminalsDb.create(db, { id: 'b', sessionId: 's1', type: 'claude-code', label: 'B', config: { role: 'agent' } });
  terminalsDb.updateStatus(db, 'b', 'working');
  db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('formatInterimNotice', () => {
  it('is the spec text, verbatim', () => {
    expect(formatInterimNotice(2)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents\n' +
      'still work. Post the recap now and mark it "interim". Then keep holding.',
    );
    expect(formatInterimNotice(1, 0)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 1 agent\n' +
      'still works. Post the recap now and mark it "interim". Then keep holding.',
    );
  });

  it('counts queued agents when only queued agents remain, and both when both do', () => {
    expect(formatInterimNotice(0, 1)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 1 agent\n' +
      'is queued. Post the recap now and mark it "interim". Then keep holding.',
    );
    expect(formatInterimNotice(0, 2)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents\n' +
      'are queued. Post the recap now and mark it "interim". Then keep holding.',
    );
    expect(formatInterimNotice(2, 1)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents\n' +
      'still work and 1 agent is queued. Post the recap now and mark it "interim". Then keep holding.',
    );
    expect(formatInterimNotice(1, 2)).toBe(
      '🕒 Interim recap due: agent turns finished 20 minutes ago, and 1 agent\n' +
      'still works and 2 agents are queued. Post the recap now and mark it "interim". Then keep holding.',
    );
  });
});

describe('nextInterimConfig', () => {
  it('arms only on a busy Finished notice with no timer running', () => {
    expect(nextInterimConfig({ role: 'coordinator' }, { kind: 'finished', busy: true, now: T0 })).toEqual({ role: 'coordinator', interimDueAt: DUE });
    expect(nextInterimConfig({ interimDueAt: DUE }, { kind: 'finished', busy: true, now: T0 + 60_000 })).toBeNull();
    expect(nextInterimConfig({}, { kind: 'blocked', busy: true, now: T0 })).toBeNull();
  });
  it('clears on any settled notice', () => {
    expect(nextInterimConfig({ role: 'coordinator', interimDueAt: DUE }, { kind: 'question', busy: false, now: T0 })).toEqual({ role: 'coordinator' });
    expect(nextInterimConfig({}, { kind: 'finished', busy: false, now: T0 })).toBeNull();
  });
});

describe('interim recap timer', () => {
  it('arms once, on a busy Finished notice', () => {
    const { db, svc } = open();
    svc.noteAgentCompletion('a');
    expect(due(db)).toBe(DUE);
    svc.clock = () => T0 + 5 * 60_000;
    svc.noteAgentCompletion('a');
    expect(due(db)).toBe(DUE); // not re-armed
  });

  it('clears on a settled notice', () => {
    const { db, svc } = open();
    svc.noteAgentCompletion('a');
    terminalsDb.updateStatus(db, 'b', 'waiting');
    svc.noteAgentCompletion('b');
    expect(due(db)).toBeUndefined();
  });

  it('clears on ledger_list with forRecap', () => {
    const { db, svc } = open();
    svc.noteAgentCompletion('a');
    new LedgerService(db).list('s1', 'coord', { forRecap: true });
    expect(due(db)).toBeUndefined();
  });

  it('fires once at the due time, while agents still work', () => {
    const { db, svc, sent } = open();
    svc.noteAgentCompletion('a');
    sent.mockClear();
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS - 1)).toEqual([]);
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual(['coord']);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]).toEqual(['coord', formatInterimNotice(1)]);
    expect(due(db)).toBeUndefined();
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS + 60_000)).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('does not fire when nothing works at the due time, and clears the timer', () => {
    const { db, svc, sent } = open();
    svc.noteAgentCompletion('a');
    sent.mockClear();
    terminalsDb.updateStatus(db, 'b', 'waiting');
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    expect(due(db)).toBeUndefined();
  });

  it('fires when only queued agents remain: busy means working or queued', () => {
    const { db, svc, sent } = open();
    svc.noteAgentCompletion('a');
    sent.mockClear();
    terminalsDb.updateStatus(db, 'b', 'queued');
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual(['coord']);
    expect(sent.mock.calls).toEqual([['coord', formatInterimNotice(0, 1)]]);
    expect(due(db)).toBeUndefined();
  });

  it('a failed delivery stays due and the next sweep retries; exactly one notice is delivered', () => {
    const { db, svc, sent } = open();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.noteAgentCompletion('a');
    sent.mockClear();
    let delivered = 0;
    sent.mockImplementationOnce(() => { throw new Error('no structured session for terminal'); })
      .mockImplementation(() => { delivered++; });
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual([]);
    expect(due(db)).toBe(DUE); // kept: the next sweep tries again
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS + 60_000)).toEqual(['coord']);
    expect(due(db)).toBeUndefined();
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS + 120_000)).toEqual([]);
    expect(delivered).toBe(1);
  });

  it('a send that returns false also stays due', () => {
    const { db, svc } = open();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.noteAgentCompletion('a');
    vi.spyOn(svc, 'sendInterimRecapNotice').mockReturnValue(false);
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual([]);
    expect(due(db)).toBe(DUE);
  });

  it('ignores a non-coordinator row that carries interimDueAt', () => {
    const { db, svc, sent } = open();
    terminalsDb.updateConfig(db, 'a', { role: 'agent', interimDueAt: DUE });
    expect(interimRecapTick(db, svc, T0 + INTERIM_RECAP_MS)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    expect(JSON.parse(terminalsDb.getById(db, 'a')!.config!).interimDueAt).toBe(DUE);
  });

  it('arms the timer only after the Finished notice reached the overseer', () => {
    const { db, svc, sent } = open();
    sent.mockImplementation(() => { throw new Error('no structured session for terminal'); });
    svc.noteAgentCompletion('a');
    expect(due(db)).toBeUndefined();
  });

  it('survives a daemon restart: the due time is in the database', () => {
    const first = open();
    first.svc.noteAgentCompletion('a');
    first.db.close();

    const second = open(); // a new process: new connection, new service
    expect(interimRecapTick(second.db, second.svc, T0 + INTERIM_RECAP_MS)).toEqual(['coord']);
    expect(second.sent).toHaveBeenCalledWith('coord', formatInterimNotice(1));
    second.db.close();
  });
});

describe('startInterimRecapLoop — the production sweep', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sweeps on its interval with the real clock, and stops when cleared', () => {
    vi.useFakeTimers({ now: T0, toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { db, svc, sent } = open();
    svc.clock = () => Date.now();
    svc.noteAgentCompletion('a');
    sent.mockClear();
    const loop = startInterimRecapLoop(db, svc, 60_000);
    vi.advanceTimersByTime(INTERIM_RECAP_MS - 60_000);
    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(sent.mock.calls).toEqual([['coord', formatInterimNotice(1)]]);
    clearInterval(loop);
    terminalsDb.updateConfig(db, 'coord', { role: 'coordinator', interimDueAt: new Date(Date.now()).toISOString() });
    vi.advanceTimersByTime(5 * 60_000);
    expect(sent).toHaveBeenCalledTimes(1);
    db.close();
  });
});
