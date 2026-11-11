// After report_status an agent ends with one short closing line (PR #159). Every reader of "what the
// agent said" must still get the report, not the closing line.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { turnTextsFromEvents, type IStructuredManager } from '../../src/structured/manager.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

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
const toolUse = (name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name, input: {} }] } });
const result = { type: 'result', subtype: 'success', is_error: false };
const REPORT = 'REPORT: the review found two medium issues in the parser.';
const CLOSING = 'Done.';
const TURN = [text(REPORT), toolUse('mcp__dispatch__report_status'), text(CLOSING), result];

function makeService(events: unknown[] | null) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const svc = new SessionService(db, new NoopPty(), '/tmp/dispatch-closing-line-test-mcp.json');
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  terminalsDb.create(db, { id: 'a', sessionId: 's1', type: 'claude-code', label: 'Reviewer', config: { role: 'agent', agentType: 'reviewer', mission: 'PR 12' } });
  const manager = Object.assign(new EventEmitter(), {
    getEvents: (id: string) => (id === 'a' && events ? events : []),
    getTurnTexts: (id: string) => (id === 'a' && events ? turnTextsFromEvents(events) : null),
    getPending: () => null,
  });
  svc.setStructuredManager(manager as unknown as IStructuredManager);
  vi.spyOn(svc, 'ensureStructuredAlive').mockReturnValue(true);
  const sent = vi.spyOn(svc, 'sendStructuredMessage').mockImplementation(() => {});
  return { db, svc, sent };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a closing line after report_status does not hide the report', () => {
  it('the finish notice carries the report', () => {
    const { svc, sent } = makeService(TURN);
    svc.noteAgentCompletion('a');
    expect(String(sent.mock.calls[0][1])).toContain(REPORT);
  });

  it('earlier narration in the turn stays out of the notice; a long last text stands alone', () => {
    const LONG = 'FINAL: ' + 'details '.repeat(40);
    const { svc, sent } = makeService([text('checking the tests now'), toolUse('Bash'), text(LONG), result]);
    svc.noteAgentCompletion('a');
    const notice = String(sent.mock.calls[0][1]);
    expect(notice).toContain('FINAL:');
    expect(notice).not.toContain('checking the tests now');
  });

  it('the outcome summary (board, scheduled roles) carries the report', () => {
    const { svc } = makeService(TURN);
    expect(svc.lastAssistantTextPublic('a')).toContain(REPORT);
  });

  it('a dependsOn worker receives the report', () => {
    const { db, svc } = makeService(TURN);
    terminalsDb.create(db, { id: 'dep', sessionId: 's1', type: 'claude-code', label: 'Fixer', config: { role: 'agent', dependsOn: 'a', queued: true, queuedTask: 'Apply the findings.' } });
    terminalsDb.updateStatus(db, 'dep', 'queued');
    let task = '';
    vi.spyOn(svc, 'startQueuedTerminal').mockImplementation((id: string, t?: string) => { task = String(t); return svc.getTerminal(id); });
    svc.noteAgentCompletion('a');
    expect(task).toContain(REPORT);
  });

  it('a report recovered from the transcript, with no live harness, keeps every text of the last turn', () => {
    const { svc } = makeService(null);
    vi.spyOn((svc as any).transcripts, 'conversationTail').mockReturnValue([
      { kind: 'user', text: 'an earlier task' },
      { kind: 'assistant', text: 'an earlier answer' },
      { kind: 'user', text: 'review PR 12' },
      { kind: 'assistant', text: REPORT },
      { kind: 'tool', toolName: 'mcp__dispatch__report_status', text: '' },
      { kind: 'assistant', text: CLOSING },
    ]);
    const out = svc.finalOutput('a');
    expect(out).toContain(REPORT);
    expect(out).toContain(CLOSING);
    expect(out).not.toContain('an earlier answer');
  });
});
