import { describe, it, expect } from 'vitest';
import { buildWatchDeliver } from '../../src/server.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

/** A SessionService stand-in with only what the wake delivery touches. */
function fakeSessions(terminal: { type: string; config?: Record<string, any> } | null, structuredFor = false) {
  const calls: { writes: [string, string][]; alive: string[]; sent: [string, string][] } = { writes: [], alive: [], sent: [] };
  const svc = {
    getTerminal: () => terminal,
    structuredManagerFor: () => (structuredFor ? {} : undefined),
    ensureStructuredAlive: (id: string) => { calls.alive.push(id); },
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
});
