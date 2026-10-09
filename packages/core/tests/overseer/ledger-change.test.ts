// The ledger:changed event (pinned card spec 2026-10-08, Unit 3): every successful ledger write
// calls onChange once with its project; a read never does, and a throwing callback never fails a write.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { wireLedger } from '../../src/server.js';
import { DECIDE_CARD, GO_CARD, LR6 } from './card-fixtures.js';

const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const min = (n: number) => new Date(T0 + n * 60_000).toISOString();
const AGENT = { id: 'agent', label: 'Readiness planner', mission: 'Readiness' };

let db: Database.Database;
let onChange: ReturnType<typeof vi.fn>;
let ledger: LedgerService;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'agent', sessionId: 's1', type: 'claude-code', label: AGENT.label, config: { role: 'agent' } });
  onChange = vi.fn();
  ledger = new LedgerService(db, { clock: () => T0 + 60 * 60_000, timeZone: 'UTC', listWorktrees: () => [], onChange });
  messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'N1: A, and never deploy on Fridays', sentAt: min(30) });
});
afterEach(() => { vi.restoreAllMocks(); });

const proposed = () => ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'How many nights?', author: 'planner', status: 'proposed', now: min(0) });

describe('LedgerService onChange', () => {
  const writes: [string, () => unknown][] = [
    ['add', () => ledger.add('s1', 'coord', { kind: 'go', text: 'Merge PR #12?', ...GO_CARD })],
    ['importItems', () => ledger.importItems('s1', 'coord', [{ kind: 'do', text: 'Check staging.', title: 'Check staging' }])],
    ['resolve', () => {
      ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'Which store?', author: 'overseer', now: min(0) });
      return ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'N1: A' });
    }],
    ['note', () => ledger.note('s1', 'coord', { quote: 'never deploy on Fridays', policy: true })],
    ['decideSelf with an id', () => { proposed(); return ledger.decideSelf('s1', 'coord', { id: 'N1', choice: 'A', reason: 'the smallest step' }); }],
    ['decideSelf without an id', () => ledger.decideSelf('s1', 'coord', { text: 'Which retry helper?', ...DECIDE_CARD, choice: 'A. 5 nights', reason: 'it covers one weekend' })],
    ['addFromAgent', () => { proposed(); return ledger.addFromAgent('s1', 'coord', { id: 'N1', title: 'Clean nights before live mode' }); }],
    ['markDefault', () => {
      ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'Which store?', author: 'overseer', now: min(0) });
      return ledger.markDefault('s1', 'coord', { id: 'N1' });
    }],
    ['captureAgentBlock', () => ledger.captureAgentBlock('s1', AGENT, [LR6])],
    ['list with forRecap', () => ledger.list('s1', 'coord', { forRecap: true })],
  ];
  for (const [name, write] of writes) {
    it(`${name} calls it once, with the project`, () => {
      write();
      expect(onChange.mock.calls).toEqual([['s1']]);
    });
  }

  it('a read, a refused write and a capture that creates nothing never call it', () => {
    ledgerDb.create(db, { sessionId: 's1', kind: 'decide', text: 'Which store?', author: 'overseer', now: min(0) });
    ledger.list('s1', 'coord');
    ledger.show('s1', 'coord', { all: true });
    ledger.handoff('s1', 'coord', ['N1']);
    ledger.card('s1');
    expect(() => ledger.add('s1', 'agent', { kind: 'do', text: 'x' })).toThrow();
    expect(() => ledger.resolve('s1', 'coord', { id: 'N1', status: 'answered', quote: 'not said' })).toThrow();
    ledger.captureAgentBlock('s1', AGENT, [{ ...LR6, why: undefined }]); // skipped: no item
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a throwing callback never fails the write', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = new LedgerService(db, { onChange: () => { throw new Error('socket gone'); } });
    expect(throwing.add('s1', 'coord', { kind: 'do', text: 'Check staging.', title: 'Check staging' })).toMatchObject({ id: 'N1' });
    expect(ledgerDb.getBySeq(db, 's1', 1)?.text).toBe('Check staging.');
  });
});

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

describe('wireLedger — both LedgerService instances broadcast ledger:changed', () => {
  it('the router\'s service and the one inside SessionService', () => {
    const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-ledger-change-test-mcp.json');
    const broadcast = vi.fn();
    const routerLedger = wireLedger(db, svc, { broadcast });
    routerLedger.add('s1', 'coord', { kind: 'do', text: 'Check staging.', title: 'Check staging' });
    expect(broadcast.mock.calls).toEqual([[{ type: 'ledger:changed', sessionId: 's1' }]]);
    // The session service's own ledger (the owner-decisions capture) is wired to the same broadcast.
    (svc as unknown as { ledger: LedgerService }).ledger.captureAgentBlock('s1', AGENT, [LR6]);
    expect(broadcast.mock.calls).toEqual([[{ type: 'ledger:changed', sessionId: 's1' }], [{ type: 'ledger:changed', sessionId: 's1' }]]);
  });

  it('a failed broadcast never fails the write', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-ledger-change-test-mcp.json');
    const routerLedger = wireLedger(db, svc, { broadcast: () => { throw new Error('closed'); } });
    expect(routerLedger.add('s1', 'coord', { kind: 'do', text: 'Check staging.', title: 'Check staging' })).toMatchObject({ id: 'N1' });
  });

  it('createApp and startServer both build their ledger with wireLedger', () => {
    const src = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    expect(src.match(/new LedgerService\(/g)).toHaveLength(1); // inside wireLedger only
    expect(src.match(/createLedgerRouter\(wireLedger\(db, sessionService, broadcaster\)\)/g)).toHaveLength(2);
  });
});
