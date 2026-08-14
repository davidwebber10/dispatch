import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import { attachUsageRecorder } from './recorder.js';

const FRAME = {
  type: 'assistant',
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }],
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  },
};

function rows(d: Database.Database) {
  return d.prepare('SELECT * FROM usage_turns ORDER BY started_at').all() as usageDb.TurnRow[];
}

describe('usage recorder', () => {
  let d: Database.Database;
  let mgr: EventEmitter;
  let termId: string;

  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    // sessionsDb.create / terminalsDb.create both require a caller-supplied `id`
    // (brief's fixture omitted it; real CreateInput has `id: string` as required).
    const projectId = randomUUID();
    sessionsDb.create(d, { id: projectId, provider: 'claude-code', name: 'P', workingDir: '/tmp/p' });
    termId = randomUUID();
    terminalsDb.create(d, { id: termId, sessionId: projectId, type: 'claude-code', label: 'chat' });
    terminalsDb.updateConfig(d, termId, { role: 'coordinator' });
    mgr = new EventEmitter();
    attachUsageRecorder(mgr, { db: d });
  });

  it('records one closed turn for busy → frame → idle', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, FRAME);
    mgr.emit('idle', termId, { declared: true });

    const all = rows(d);
    expect(all.length).toBe(1);
    expect(all[0].output_tokens).toBe(20);
    expect(all[0].input_tokens).toBe(10);
    expect(all[0].cache_read_tokens).toBe(5);
    expect(all[0].tool_calls).toBe(1);
    expect(all[0].messages).toBe(1);
    expect(all[0].model).toBe('claude-opus-5');
    expect(all[0].outcome).toBe('idle');
    expect(all[0].ended_at).not.toBeNull();
  });

  // The regression test for the noteAgentCompletion trap: that hook returns early
  // on role !== 'agent', so a recorder hung off it would silently miss chat threads.
  it('records a turn for a non-agent chat thread', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, FRAME);
    mgr.emit('idle', termId, { declared: false });
    expect(rows(d).length).toBe(1);
    expect(rows(d)[0].role).toBe('coordinator');
  });

  it('sums several frames into one turn without double counting', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, FRAME);
    mgr.emit('event', termId, FRAME);
    mgr.emit('idle', termId, { declared: true });
    const all = rows(d);
    expect(all.length).toBe(1);
    expect(all[0].output_tokens).toBe(40);
    expect(all[0].messages).toBe(2);
  });

  it('closes with the right outcome for needs-help, scheduled and exit', () => {
    for (const [event, payload, outcome] of [
      ['needs-help', { ask: 'a', summary: 's', inferred: false }, 'needs_help'],
      ['scheduled', 'waking later', 'scheduled'],
      ['exit', 0, 'exit'],
    ] as const) {
      mgr.emit('busy', termId);
      mgr.emit('event', termId, FRAME);
      mgr.emit(event, termId, payload);
      const open = usageDb.findOpenTurn(d, termId);
      expect(open).toBeNull();
    }
    expect(rows(d).map((r) => r.outcome)).toEqual(['needs_help', 'scheduled', 'exit']);
  });

  it('ignores frames that arrive with no open turn', () => {
    mgr.emit('event', termId, FRAME);
    expect(rows(d).length).toBe(0);
  });

  it('ignores events for an unknown terminal', () => {
    mgr.emit('busy', 'ghost');
    mgr.emit('idle', 'ghost', { declared: true });
    expect(rows(d).length).toBe(0);
  });

  it('never throws when the database rejects a write', () => {
    d.exec('DROP TABLE usage_turns');
    expect(() => {
      mgr.emit('busy', termId);
      mgr.emit('event', termId, FRAME);
      mgr.emit('idle', termId, { declared: true });
    }).not.toThrow();
  });

  it('calls onTurnClosed once per closed turn', () => {
    let closed = 0;
    const m2 = new EventEmitter();
    attachUsageRecorder(m2, { db: d, onTurnClosed: () => { closed += 1; } });
    m2.emit('busy', termId);
    m2.emit('idle', termId, { declared: true });
    expect(closed).toBe(1);
  });
});
