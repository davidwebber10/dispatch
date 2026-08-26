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

  /*
   * The turn opens with `terminal.config.model`, which sessions/service.ts writes
   * as modelFor(config) — a bare CLI tier alias, never a model id. A row that kept
   * the alias would appear as a second key in every by-model chart, splitting a
   * single model across two series. The frame knows the real id, so it wins.
   */
  it('replaces the config tier alias with the model the frame names', () => {
    terminalsDb.updateConfig(d, termId, { role: 'coordinator', model: 'sonnet' });
    mgr.emit('busy', termId);
    // The row really did open with the alias — otherwise this test would pass for
    // the wrong reason.
    expect(usageDb.findOpenTurn(d, termId)!.model).toBe('sonnet');

    mgr.emit('event', termId, {
      type: 'assistant',
      message: { model: 'claude-sonnet-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    mgr.emit('idle', termId, { declared: true });

    expect(rows(d)[0].model).toBe('claude-sonnet-5');
  });

  /*
   * Codex must NOT be collateral damage. structured/codex-translate.ts names a
   * model only in its `init` frame, which carries no usage — its usage frames are
   * `{ type:'assistant', message:{ role, content: [], usage } }` with no `model`.
   * So the guard never fires and the Codex slug from config survives.
   */
  it('keeps a Codex slug when the frame names no model', () => {
    terminalsDb.updateConfig(d, termId, { role: 'coordinator', model: 'gpt-5.6-sol' });
    mgr.emit('busy', termId);
    mgr.emit('event', termId, {
      type: 'assistant',
      message: { role: 'assistant', content: [], usage: { input_tokens: 7, cache_read_input_tokens: 2, output_tokens: 3 } },
    });
    mgr.emit('idle', termId, { declared: true });

    expect(rows(d)[0].model).toBe('gpt-5.6-sol');
    expect(rows(d)[0].output_tokens).toBe(3);
  });

  /*
   * The OpenCode shape: the context_fill gauge re-reports the whole context as
   * input_tokens on every publish, and the real per-turn bill arrives once at
   * the boundary (grok-translate.ts promptResult). Only the bill may land in
   * the row — counting the gauge recorded 8736 input / 0 output / 0 cache for
   * a turn that really cost 1311 / 6 / 7425.
   */
  it('records the OpenCode boundary usage frame and skips the context_fill gauge', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, {
      type: 'assistant', subtype: 'context_fill',
      message: { role: 'assistant', model: 'openrouter/z-ai/glm-5.2', content: [], usage: { input_tokens: 8736, output_tokens: 0 } },
    });
    mgr.emit('event', termId, {
      type: 'assistant',
      message: { role: 'assistant', model: 'openrouter/z-ai/glm-5.2', content: [], usage: { input_tokens: 1311, cache_read_input_tokens: 7425, output_tokens: 6 } },
    });
    mgr.emit('idle', termId, { declared: false });

    const all = rows(d);
    expect(all.length).toBe(1);
    expect(all[0].input_tokens).toBe(1311);
    expect(all[0].cache_read_tokens).toBe(7425);
    expect(all[0].output_tokens).toBe(6);
    expect(all[0].messages).toBe(1); // the gauge is not a usage-bearing message
  });

  /*
   * OpenCode reports a REAL per-turn dollar cost (the translator computes the
   * delta and rides it on the acp_turn result footer). pricing.ts deliberately
   * has no entry for OpenRouter models because this figure exists — so the
   * recorder has to actually store it, or the exclusion's premise is false.
   */
  it('adds a per-turn reported cost from an ACP result footer', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, {
      type: 'result', subtype: 'acp_turn', is_error: false,
      usage: { input_tokens: 1311, output_tokens: 6 }, total_cost_usd: 0.0024469632,
    });
    mgr.emit('idle', termId, { declared: false });
    expect(rows(d)[0].cost_usd).toBeCloseTo(0.0024469632, 10);
    // Footer usage is turn-aggregate, not a message — never double counted.
    expect(rows(d)[0].input_tokens).toBe(0);
  });

  /*
   * Claude's own result footer also carries total_cost_usd, but that figure is
   * SESSION-cumulative — summing it per turn would multiply the real number.
   * Claude turns are priced from their tokens instead; only the translator-owned
   * per-turn deltas (acp_turn / grok_turn) may be ingested.
   */
  it('never ingests a Claude result footer cost', () => {
    mgr.emit('busy', termId);
    mgr.emit('event', termId, {
      type: 'result', subtype: 'success', total_cost_usd: 1.23,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    mgr.emit('idle', termId, { declared: true });
    expect(rows(d)[0].cost_usd).toBe(0);
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
