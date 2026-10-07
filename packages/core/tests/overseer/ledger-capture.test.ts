// Agent blocks become proposed items (decision cards spec 2026-10-06, Unit 3).
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { renderCard } from '../../src/overseer/ledger-render.js';
import { LR6 } from './card-fixtures.js';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
let db: Database.Database;
let ledger: LedgerService;
const AGENT = { id: 'planner-1', label: 'Readiness planner', mission: 'Readiness' };


beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: AGENT.id, sessionId: 's1', type: 'claude-code', label: AGENT.label, config: { role: 'agent', agentType: 'planner', mission: AGENT.mission } });
  ledger = new LedgerService(db, { clock: () => T0, timeZone: 'UTC', listWorktrees: () => [] });
});

describe('captureAgentBlock', () => {
  it('each valid entry becomes a proposed item with the agent\'s text word for word', () => {
    const out = ledger.captureAgentBlock('s1', AGENT, [LR6, { ...LR6, id: 'LR-7', question: 'Which day does the switch happen?' }]);
    expect(out).toEqual({ created: [1, 2], skipped: [] });
    const item = ledgerDb.getBySeq(db, 's1', 1)!;
    expect(item).toMatchObject({
      status: 'proposed', kind: 'decide', text: LR6.question, author: 'Readiness planner', mission: 'Readiness',
      context: LR6.context, options: LR6.options, recommendation: LR6.recommendation, recommendationWhy: LR6.why,
      defaultText: LR6.default, sourceKind: 'agent', sourceRef: 'Readiness planner',
      sourceSection: 'docs/plans/readiness.md#Owner decisions', sourceId: 'LR-6',
      agentTerminalId: 'planner-1', agentDecisionId: 'LR-6', sentAt: null,
    });
    // The card shows the spec's source line.
    expect(renderCard(item, { now: T0, timeZone: 'UTC' })).toContain(
      'Source: plan `docs/plans/readiness.md`, section "Owner decisions" (`LR-6`), from agent "Readiness planner"',
    );
  });

  it('an invalid entry is skipped and named by its id and the failed check; the others still land', () => {
    const { why: _w, ...noWhy } = LR6;
    const out = ledger.captureAgentBlock('s1', AGENT, [
      { ...noWhy, id: 'LR-7' },
      { ...LR6, id: 'LR-8', question: 'Approve D1 to D9?' },
      LR6,
      'not an object',
      { question: 'no id here?' },
      { ...LR6, id: 'LR-9', question: '' },
      { ...LR6, id: 'LR-10', kind: 'do' },
    ]);
    expect(out.created).toEqual([1]);
    expect(out.skipped).toEqual([
      { id: 'LR-7', reason: 'A decision card needs: why. Add them and try again.' },
      { id: 'LR-8', reason: 'One decision per card. Add each decision on its own.' },
      { id: '#4', reason: 'the entry is not an object' },
      { id: '#5', reason: 'the entry has no id' },
      { id: 'LR-9', reason: 'the entry has no question' },
      { id: 'LR-10', reason: "kind must be 'decide' or 'go'" },
    ]);
  });

  it('a missing kind reads as decide; a go entry works; where is optional', () => {
    const { kind: _k, where: _w, ...plain } = LR6;
    const go = { id: 'G1', kind: 'go', question: 'Merge the sync PR?', context: 'The sync PR is reviewed and green.', default: 'Nothing happens.' };
    expect(ledger.captureAgentBlock('s1', AGENT, [plain, go]).created).toEqual([1, 2]);
    expect(ledgerDb.getBySeq(db, 's1', 1)).toMatchObject({ kind: 'decide', sourceSection: null });
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({ kind: 'go', status: 'proposed' });
    expect(renderCard(ledgerDb.getBySeq(db, 's1', 1)!, { now: T0 })).toContain('Source: agent "Readiness planner" (`LR-6`)');
  });

  it('a where with a section but no path keeps the section', () => {
    ledger.captureAgentBlock('s1', AGENT, [{ ...LR6, where: { section: 'Risks' } }]);
    expect(renderCard(ledgerDb.getBySeq(db, 's1', 1)!, { now: T0 })).toContain('Source: agent "Readiness planner", section "Risks" (`LR-6`)');
  });

  it('a repeat with the same question changes nothing', () => {
    ledger.captureAgentBlock('s1', AGENT, [LR6]);
    expect(ledger.captureAgentBlock('s1', AGENT, [{ ...LR6, question: '  How many clean   nights before live mode? ' }])).toEqual({ created: [], skipped: [] });
    expect(ledgerDb.listBySession(db, 's1')).toHaveLength(1);
  });

  it('a changed question supersedes the old item while it is still proposed', () => {
    ledger.captureAgentBlock('s1', AGENT, [LR6]);
    expect(ledger.captureAgentBlock('s1', AGENT, [{ ...LR6, question: 'How many clean nights before live mode, counting weekends?' }]).created).toEqual([2]);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('superseded');
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({ status: 'proposed', supersedes: 1 });
  });

  it('a changed question after triage is a new proposed item; the triaged one keeps its status', () => {
    ledger.captureAgentBlock('s1', AGENT, [LR6]);
    db.prepare("UPDATE ledger_items SET status = 'open', sent_at = ? WHERE seq = 1").run(new Date(T0).toISOString());
    expect(ledger.captureAgentBlock('s1', AGENT, [{ ...LR6, question: 'How many clean nights, counting weekends?' }]).created).toEqual([2]);
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open');
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({ status: 'proposed', supersedes: null });
  });

  it('an entry cannot set blocks, author, status, policy, supersedes, sent_at or origin: the daemon sets them', () => {
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'An open question of the overseer?', author: 'overseer', now: new Date(T0).toISOString() }); // N1, open
    const out = ledger.captureAgentBlock('s1', AGENT, [{
      ...LR6, blocks: 'the release', author: 'you', status: 'open', policy: true, supersedes: 'N1', sent_at: '2026-01-01T00:00:00.000Z',
      sentAt: '2026-01-01T00:00:00.000Z', origin: 'imported', decided_choice: 'A. 5 nights', reason: 'x',
    }]);
    expect(out.created).toEqual([2]);
    expect(ledgerDb.getBySeq(db, 's1', 2)).toMatchObject({
      blocks: null, author: 'Readiness planner', status: 'proposed', policy: false, supersedes: null, sentAt: null, origin: 'live',
      decidedChoice: null, decidedAt: null, reason: null,
    });
    expect(ledgerDb.getBySeq(db, 's1', 1)!.status).toBe('open'); // not superseded by the entry
  });

  it('the same id from another agent is a separate decision', () => {
    terminalsDb.create(db, { id: 'researcher-1', sessionId: 's1', type: 'claude-code', label: 'Map researcher', config: { role: 'agent' } });
    ledger.captureAgentBlock('s1', AGENT, [LR6]);
    expect(ledger.captureAgentBlock('s1', { id: 'researcher-1', label: 'Map researcher', mission: null }, [LR6]).created).toEqual([2]);
  });
});
