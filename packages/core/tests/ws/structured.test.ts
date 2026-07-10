// packages/core/tests/ws/structured.test.ts
import { it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStructuredConnection } from '../../src/ws/structured.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');

// Minimal fake `ws` capturing sent frames + close handler.
function fakeWs() {
  let closeCb: (() => void) | undefined;
  const sent: any[] = [];
  return {
    readyState: 1,
    sent,
    send: (s: string) => sent.push(JSON.parse(s)),
    on: (ev: string, cb: () => void) => { if (ev === 'close') closeCb = cb; },
    close: () => {},
    fireClose: () => closeCb?.(),
  };
}

let m: StructuredSessionManager;
beforeEach(() => { m = new StructuredSessionManager(); });

it("forwards manager 'exit' as a synthetic error result so busy clears (P0b)", () => {
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m);
  m.emit('exit', 't1', 137);
  const res = ws.sent.find((e) => e.type === 'result');
  expect(res).toBeTruthy();
  expect(res.is_error).toBe(true);
  expect(res.subtype).toBe('process_exit');
  expect(res.result).toContain('137');
});

it('only forwards exit for THIS terminal', () => {
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m);
  m.emit('exit', 'other', 1);
  expect(ws.sent.find((e) => e.type === 'result')).toBeFalsy();
});

it("unsubscribes from 'exit' on ws close (no leak / no send after close)", () => {
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m);
  ws.fireClose();
  m.emit('exit', 't1', 1);
  expect(ws.sent.find((e) => e.type === 'result')).toBeFalsy();
});

it('with no `tail` param, replays the full ring (back-compat)', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ type: 'user', message: { content: [{ type: 'text', text: `msg-${i}` }] } }));
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m);
  const seeded = ws.sent.filter((e) => JSON.stringify(e).includes('msg-'));
  expect(seeded).toHaveLength(30);
});

it("bounds replay to the last N events when `?tail=N` is present", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ type: 'user', message: { content: [{ type: 'text', text: `msg-${i}` }] } }));
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws?tail=5' } as any, m);
  const seeded = ws.sent.filter((e) => JSON.stringify(e).includes('msg-'));
  expect(seeded).toHaveLength(5);
  expect(JSON.stringify(seeded[0])).toContain('msg-25');
  expect(JSON.stringify(seeded[4])).toContain('msg-29');
});

// The 'system'/'inactive' sentinel tells the client to hydrate its initial view from the REST
// transcript instead of sitting on an empty view. The rule is "send it iff there is nothing to
// REPLAY" — because whatever isn't in the ring won't reach the client through the live channel.
// This covers BOTH: (1) no live process (archived/queued — the ring has nothing and never
// will), and (2) an ALIVE thread whose in-memory ring is empty after a daemon restart (the CLI
// is resumed with its session, but its history was never backfilled into the ring, and the live
// channel only carries FUTURE turns). See useStructuredChat's 'system'/'inactive' handler; it
// only hydrates if `items` is still empty, so the sentinel is harmless when replay is non-empty.
it("sends a 'system'/'inactive' sentinel when there's nothing to replay and no live process (archived)", () => {
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m, () => false);
  expect(ws.sent[0]).toEqual({ type: 'system', subtype: 'inactive' });
});

// Regression: an ALIVE coordinator whose ring is empty (process survived a daemon restart, so
// ensureStructuredAlive never revived+backfilled it) must still get the sentinel — otherwise its
// long transcript never loads and it shows the new-session greeting despite having history.
it("sends the 'inactive' sentinel for an ALIVE thread when its ring is empty (nothing to replay)", () => {
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m, () => true);
  expect(ws.sent.some((e) => e.type === 'system' && e.subtype === 'inactive')).toBe(true);
});

it("sends NO sentinel when the ring HAS events to replay (alive — replay provides the content)", () => {
  const history = Array.from({ length: 3 }, (_, i) => ({ type: 'user', message: { content: [{ type: 'text', text: `msg-${i}` }] } }));
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m, () => true);
  expect(ws.sent.some((e) => e.type === 'system' && e.subtype === 'inactive')).toBe(false);
  expect(ws.sent.filter((e) => JSON.stringify(e).includes('msg-'))).toHaveLength(3); // replay happened
});

it('sends NO sentinel when no onConnect hook is supplied and the ring has events (back-compat)', () => {
  const history = [{ type: 'user', message: { content: [{ type: 'text', text: 'msg-0' }] } }];
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m);
  expect(ws.sent.some((e) => e.type === 'system' && e.subtype === 'inactive')).toBe(false);
});

it('a throwing onConnect is best-effort (does not crash) and still replays buffered events', () => {
  const history = [{ type: 'user', message: { content: [{ type: 'text', text: 'msg-0' }] } }];
  m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), seedEvents: history });
  const ws = fakeWs();
  handleStructuredConnection(ws as any, { url: '/api/terminals/t1/structured-ws' } as any, m, () => { throw new Error('boom'); });
  expect(ws.sent.filter((e) => JSON.stringify(e).includes('msg-'))).toHaveLength(1);
});
