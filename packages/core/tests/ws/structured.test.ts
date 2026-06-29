// packages/core/tests/ws/structured.test.ts
import { it, expect, beforeEach } from 'vitest';
import { handleStructuredConnection } from '../../src/ws/structured.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';

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
