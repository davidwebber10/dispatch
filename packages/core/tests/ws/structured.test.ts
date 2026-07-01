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
