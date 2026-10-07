// The Finished notice reads the agent's owner-decisions block from its FULL final message
// (decision cards spec 2026-10-06, Unit 3), not from the 600-character summary.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { turnTextsFromEvents, type IStructuredManager } from '../../src/structured/manager.js';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
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
  // A Claude-shaped ring: the turn texts come from it as the Claude manager reads its own ring.
  const manager = Object.assign(new EventEmitter(), {
    getEvents: (id: string) => (id === 'a' ? events : []),
    getTurnTexts: (id: string) => (id === 'a' ? turnTextsFromEvents(events) : null),
    getPending: () => null,
  });
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

  it('a sub-agent\'s block is never captured as the agent\'s own', () => {
    const subAgent = { ...text(report(fenced([LR6]))), parent_tool_use_id: 'toolu_01' };
    const { db, svc, sent } = makeService([result, subAgent, text('My own report. Nothing for the owner.'), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
    expect(String(sent.mock.calls[0][1])).not.toContain('owner decision');
  });

  it('a block over the size limit is a broken block: the notice says why, and no item changes', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...LR6, id: `LR-${i + 1}`, question: `Question ${i + 1}?` }));
    const { db, svc, sent } = makeService([text(report(fenced(many))), result]);
    svc.noteAgentCompletion('a');
    expect(ledgerDb.listBySession(db, 's1')).toEqual([]);
    expect(String(sent.mock.calls[0][1])).toContain('The owner-decisions block could not be read: the block has 51 entries; the limit is 50. Ask the agent to fix it.');
  });
});

// A Codex agent streams its prose as deltas; the complete text travels with each agentMessage
// item/completed. The real Codex manager and translator, driven by the fake app-server.
describe('owner-decisions block from a Codex agent', () => {
  const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-codex-app-server.mjs');

  it('is read from the completed agentMessage items, also when a short line follows report_status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-decisions-'));
    const m = new CodexStructuredSessionManager();
    try {
      const reportFile = path.join(dir, 'report.json');
      fs.writeFileSync(reportFile, JSON.stringify([report(fenced([LR6])), 'Done.']));
      const db = new Database(':memory:');
      initSchema(db);
      sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: dir });
      const svc = new SessionService(db, new NoopPty(), path.join(dir, 'mcp.json'));
      terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
      terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'codex', label: 'Readiness planner', config: { role: 'agent', agentType: 'planner', transport: 'structured' } });
      svc.registerStructuredManager('codex', m);
      vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
      const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
      // What server.ts does at an idle turn end.
      const settled = new Promise<void>((resolve) => m.on('idle', (id: string) => { svc.noteAgentCompletion(id); resolve(); }));

      m.spawn('a', { command: process.execPath, args: [fake], workDir: dir });
      m.sendMessage('a', `report-file ${reportFile}`);
      await settled;

      expect(m.getEvents('a').some((e: any) => e.type === 'assistant' && e.message?.content?.some((b: any) => b.type === 'text'))).toBe(false);
      expect(ledgerDb.listProposedSeqs(db, 's1')).toEqual([1]);
      expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ text: LR6.question, agentTerminalId: 'a', sourceId: 'LR-6' });
      expect(String(sent.mock.calls[0][1])).toContain('This report has 1 owner decision (N1).');
    } finally {
      m.killAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
