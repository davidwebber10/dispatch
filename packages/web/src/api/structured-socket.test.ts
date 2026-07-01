// packages/web/src/api/structured-socket.test.ts
import { test, expect } from 'vitest';
import { openStructuredSocket, type TerminalWS } from './structured-socket';

test('opens the ws with a bounded ?tail= param so replay stays fast on long threads', () => {
  let openedUrl = '';
  const fakeWs: TerminalWS = { onopen: null, onclose: null, onmessage: null, send: () => {}, close: () => {} };
  const sock = openStructuredSocket({
    terminalId: 't1',
    onEvent: () => {},
    wsFactory: (u) => { openedUrl = u; return fakeWs; },
  });
  expect(openedUrl).toBe('ws://localhost:3000/api/terminals/t1/structured-ws?tail=200');
  sock.close();
});
