// The Finished notice reads the agent's owner-decisions block from its FULL final message
// (decision cards spec 2026-10-06, Unit 3), not from the 600-character summary.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { IStructuredManager } from '../../src/structured/manager.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { LR6 } from '../overseer/card-fixtures.js';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

const text = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const tool = (name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input: {} }] } });
const result = { type: 'result', subtype: 'success', is_error: false };
const fenced = (entries: unknown) => '```owner-decisions\n' + JSON.stringify(entries, null, 2) + '\n```';
/** A long report: the block starts well past the 600 characters a notice summary keeps. */
const report = (block: string) => `Plan is ready.\n\n${'Findings and steps. '.repeat(60)}\n\n${block}`;

function makeService(events: unknown[], config: Record<string, unknown> = {}) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-owner-decisions-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'Readiness planner', config: { role: 'agent', agentType: 'planner', mission: 'Readiness', ...config } });
  const manager = Object.assign(new EventEmitter(), { getEvents: (id: string) => (id === 'a' ? events : []), getPending: () => null });
  svc.setStructuredManager(manager as unknown as IStructuredManager);
  vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  return { db, svc, sent };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('owner-decisions block on the Finished notice', () => {
  it('a valid block: proposed items and the count line, read from the full final message', () => {
    const entries = [LR6, { ...LR6, id: 'LR-7', question: 'Which day does the switch happen?' }];
    const { db, svc, sent } = makeService([text('working on it'), tool('Read'), text(report(fenced(entries))), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listProposedSeqs(db, 's1')).toEqual([1, 2]);
    const notice = String(sent.mock.calls[0][1]);
    expect(notice).toContain('Its latest output: Plan is ready.');
    expect(notice).not.toContain('"LR-6"'); // the summary is cut at 600 characters, before the block
    expect(notice).toContain('\n\nThis report has 2 owner decisions (N1, N2). Triage each now: ledger_add_from_agent sends it to the user; ledger_decide_self records your own choice.\n\nBatch:');
  });

  it('an invalid entry is named; the valid ones still land', () => {
    const { why: _w, ...noWhy } = LR6;
    const { db, svc, sent } = makeService([text(report(fenced([LR6, { ...noWhy, id: 'LR-7' }]))), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listProposedSeqs(db, 's1')).toEqual([1]);
    const notice = String(sent.mock.calls[0][1]);
    expect(notice).toContain('This report has 1 owner decision (N1).');
    expect(notice).toContain('Skipped owner decision LR-7: A decision card needs: why. Add them and try again.');
  });

  it('a broken block: the fixed line, and no item changes', () => {
    const { db, svc, sent } = makeService([text(report('```owner-decisions\n[{"id": "LR-6",}]\n```')), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
    expect(String(sent.mock.calls[0][1])).toMatch(/The owner-decisions block could not be read: it is not valid JSON \(.+\)\. Ask the agent to fix it\./);
  });

  it('no block: no line and no item', () => {
    const { db, svc, sent } = makeService([text('Plan is ready. Nothing for the owner.'), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
    expect(String(sent.mock.calls[0][1])).not.toContain('owner decision');
  });

  it('a block before the last tool call of the same turn still counts (text after report_status)', () => {
    const { db, svc } = makeService([result, text(report(fenced([LR6]))), tool('mcp__dispatch__report_status'), text('Done.'), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listProposedSeqs(db, 's1')).toEqual([1]);
  });

  it('a block from an earlier turn is not read again', () => {
    const { db, svc } = makeService([text(report(fenced([LR6]))), result, text('Small follow-up done.'), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });

  it('the same report delivered twice creates its items once', () => {
    const { db, svc, sent } = makeService([text(report(fenced([LR6]))), result]);
    svc.noteAgentCompletion('a');
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toHaveLength(1);
    expect(String(sent.mock.calls[1][1])).not.toContain('owner decision');
  });

  it('a scheduled role run is never read', () => {
    const { db, svc } = makeService([text(report(fenced([LR6]))), result], { roleRun: 'nightly-check' });
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
  });

  it('a capture failure never drops the notice', () => {
    const { db, svc, sent } = makeService([text(report(fenced([LR6]))), result]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.exec('DROP TABLE ledger_items');
    svc.noteAgentCompletion('a');
    expect(String(sent.mock.calls[0][1])).toContain('just finished a turn');
  });
});
