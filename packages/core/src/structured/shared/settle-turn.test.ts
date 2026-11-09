// packages/core/src/structured/shared/settle-turn.test.ts
import { describe, it, expect } from 'vitest';
import { settleTurn, type SettleSession } from './settle-turn.js';

function harness(withSummary = true) {
  const emitted: unknown[][] = [];
  const deps = {
    idle: (terminalId: string, detail: unknown) => { emitted.push(['idle', terminalId, detail]); },
    needsHelp: (terminalId: string, detail: unknown) => { emitted.push(['needs-help', terminalId, detail]); },
    withSummary,
  };
  return { emitted, deps };
}

describe('settleTurn', () => {
  it('idle settles once per turn', () => {
    const { emitted, deps } = harness();
    const session: SettleSession = { terminalId: 't1' };
    settleTurn(session, { kind: 'idle', summary: 'did it', turnId: 'turn-1' }, deps);
    expect(emitted).toEqual([['idle', 't1', { declared: false, summary: 'did it' }]]);
    // The next turn settles again.
    settleTurn(session, { kind: 'idle', summary: 'again', turnId: 'turn-2' }, deps);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(['idle', 't1', { declared: false, summary: 'again' }]);
  });

  it('a second settle for the same turn is ignored', () => {
    const { emitted, deps } = harness();
    const session: SettleSession = { terminalId: 't1' };
    settleTurn(session, { kind: 'idle', summary: 'one', turnId: 'turn-1' }, deps);
    session.declared = { state: 'needs_you', summary: 'late', ask: 'late?' };
    settleTurn(session, { kind: 'needs-help', ask: 'q?', summary: 'q?', turnId: 'turn-1' }, deps);
    expect(emitted).toHaveLength(1);
    // The ignored settle did not eat the declaration of the turn that follows.
    expect(session.declared).toEqual({ state: 'needs_you', summary: 'late', ask: 'late?' });
  });

  it('a settle with no turn id is never ignored (a harness without turn ids)', () => {
    const { emitted, deps } = harness();
    const session: SettleSession = { terminalId: 't1' };
    settleTurn(session, { kind: 'idle' }, deps);
    settleTurn(session, { kind: 'idle' }, deps);
    expect(emitted).toHaveLength(2);
  });

  it('needs-help marks the declaration', () => {
    const { emitted, deps } = harness();
    const session: SettleSession = { terminalId: 't1', declared: { state: 'needs_you', summary: 'Pick a rail', ask: 'A or B?' } };
    settleTurn(session, { kind: 'idle', summary: 'closing text' }, deps);
    expect(emitted).toEqual([['needs-help', 't1', { ask: 'A or B?', summary: 'Pick a rail', inferred: false }]]);
    expect(session.declared).toBeUndefined(); // a declaration is for one turn
    // With no declaration, a question the translator found is a guess.
    settleTurn(session, { kind: 'needs-help', ask: 'Shall I?', summary: 'Shall I?' }, deps);
    expect(emitted[1]).toEqual(['needs-help', 't1', { ask: 'Shall I?', summary: 'Shall I?', inferred: true }]);
  });

  it('a declared needs_you with no ask uses its summary', () => {
    const { emitted, deps } = harness();
    settleTurn({ terminalId: 't1', declared: { state: 'needs_you', summary: 'Which one?' } }, { kind: 'idle' }, deps);
    expect(emitted[0]).toEqual(['needs-help', 't1', { ask: 'Which one?', summary: 'Which one?', inferred: false }]);
  });

  it('a declared done or blocked settles idle with its state, and wins over a guessed question', () => {
    const { emitted, deps } = harness();
    settleTurn({ terminalId: 't1', declared: { state: 'done', summary: 's' } }, { kind: 'needs-help', ask: 'q?', summary: 'q?' }, deps);
    settleTurn({ terminalId: 't1', declared: { state: 'blocked', summary: 's', blocker: 'agent B' } }, { kind: 'idle', summary: 'text' }, deps);
    settleTurn({ terminalId: 't1', declared: { state: 'blocked', summary: 's' } }, { kind: 'idle', summary: 'text' }, deps);
    expect(emitted).toEqual([
      ['idle', 't1', { declared: true, state: 'done', summary: 'q?' }],
      ['idle', 't1', { declared: true, state: 'blocked', summary: 'text', blocker: 'agent B' }],
      ['idle', 't1', { declared: true, state: 'blocked', summary: 'text' }],
    ]);
  });

  it('without withSummary (Claude) the detail has no summary key', () => {
    const { emitted, deps } = harness(false);
    settleTurn({ terminalId: 't1' }, { kind: 'idle' }, deps);
    settleTurn({ terminalId: 't1', declared: { state: 'done', summary: 's' } }, { kind: 'idle' }, deps);
    expect(emitted).toStrictEqual([
      ['idle', 't1', { declared: false }],
      ['idle', 't1', { declared: true, state: 'done' }],
    ]);
  });
});
