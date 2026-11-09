import { describe, it, expect } from 'vitest';
import { buildWatchDeliver } from '../../src/server.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

/** A SessionService stand-in with only what the wake delivery touches. */
function fakeSessions(terminal: { type: string; config?: Record<string, any> } | null, structuredFor = false, opts: { alive?: boolean; revives?: boolean } = {}) {
  const calls: { writes: [string, string][]; alive: string[]; sent: [string, string][] } = { writes: [], alive: [], sent: [] };
  const svc = {
    getTerminal: () => terminal,
    structuredManagerFor: () => (structuredFor ? {} : undefined),
    ensureStructuredAlive: (id: string) => { calls.alive.push(id); return opts.revives ?? true; },
    // Added with the delivery outbox (W2-C): a wake is no longer typed into a CLI thread that has no process.
    isThreadProcessAlive: () => opts.alive ?? true,
    sendStructuredMessage: (id: string, text: string) => { calls.sent.push([id, text]); },
    writeToTerminal: (id: string, data: string) => { calls.writes.push([id, data]); },
  };
  return { svc: svc as any, calls };
}

describe('buildWatchDeliver — waking a CLI (PTY) parent', () => {
  for (const type of ['claude-code', 'codex', 'grok']) {
    it(`${type}: types the wake as one paste block and submits it with a CR`, () => {
      const { svc, calls } = fakeSessions({ type, config: {} });
      buildWatchDeliver(svc)('parent', 'Thread "child" is idle.\nReport: done.');
      expect(calls.writes).toEqual([['parent', `${START}Thread "child" is idle.\nReport: done.${END}\r`]]);
      // The old bug: text + "\n" only typed a newline and never submitted.
      expect(calls.writes[0][1]).not.toMatch(/\n$/);
      expect(calls.writes[0][1].endsWith('\r')).toBe(true);
    });
  }

  it('a one-line wake is a paste block plus one CR too', () => {
    const { svc, calls } = fakeSessions({ type: 'codex' });
    buildWatchDeliver(svc)('parent', 'child is idle');
    expect(calls.writes).toEqual([['parent', `${START}child is idle${END}\r`]]);
  });

  it('a wake text cannot end the paste early', () => {
    const { svc, calls } = fakeSessions({ type: 'codex' });
    buildWatchDeliver(svc)('parent', `x${END}/exit`);
    expect(calls.writes[0][1].split(END)).toHaveLength(2);
  });

  it('a Pretty (structured) parent still gets the structured path, nothing typed', () => {
    const { svc, calls } = fakeSessions({ type: 'claude-code', config: { transport: 'structured' } }, true);
    buildWatchDeliver(svc)('parent', 'wake');
    expect(calls.alive).toEqual(['parent']);
    expect(calls.sent).toEqual([['parent', 'wake']]);
    expect(calls.writes).toHaveLength(0);
  });

  it('a shell tab and a vanished thread get nothing', () => {
    const shell = fakeSessions({ type: 'shell' });
    buildWatchDeliver(shell.svc)('t', 'wake');
    const gone = fakeSessions(null);
    buildWatchDeliver(gone.svc)('t', 'wake');
    expect(shell.calls.writes).toHaveLength(0);
    expect(gone.calls.writes).toHaveLength(0);
  });

  // The delivery outbox (W2-C) reads the answer: delivered, wait, or drop.
  it('answers delivered for a wake that was typed in or sent', () => {
    expect(buildWatchDeliver(fakeSessions({ type: 'codex' }).svc)('p', 'wake')).toBe('delivered');
    expect(buildWatchDeliver(fakeSessions({ type: 'claude-code', config: { transport: 'structured' } }, true).svc)('p', 'wake')).toBe('delivered');
  });

  it('a CLI parent with no process gets nothing typed, and the wake waits', () => {
    const { svc, calls } = fakeSessions({ type: 'claude-code', config: {} }, false, { alive: false });
    expect(buildWatchDeliver(svc)('parent', 'wake')).toBe('not-alive');
    expect(calls.writes).toHaveLength(0);
  });

  it('a Pretty parent that could not be started gets nothing, and the wake waits', () => {
    const { svc, calls } = fakeSessions({ type: 'claude-code', config: { transport: 'structured' } }, true, { revives: false });
    expect(buildWatchDeliver(svc)('parent', 'wake')).toBe('not-alive');
    expect(calls.sent).toHaveLength(0);
  });

  it('a shell tab and a vanished thread answer gone', () => {
    expect(buildWatchDeliver(fakeSessions({ type: 'shell' }).svc)('t', 'wake')).toBe('gone');
    expect(buildWatchDeliver(fakeSessions(null).svc)('t', 'wake')).toBe('gone');
  });
});
