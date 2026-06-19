import { expect, test } from 'vitest';
import { openTerminalSocket, type TerminalWS } from './terminal-socket';

class FakeTermWS implements TerminalWS {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.(); }
}

test('forwards output, sends raw input, and frames resize as JSON', () => {
  const chunks: string[] = [];
  let ws!: FakeTermWS;
  const sock = openTerminalSocket({
    terminalId: 't1',
    onData: (c) => chunks.push(c),
    wsFactory: () => (ws = new FakeTermWS()),
  });

  ws.onmessage!({ data: 'hello world' });
  expect(chunks).toEqual(['hello world']);

  ws.onopen!(); // simulate the socket opening so queued sends flush

  sock.send('ls\r');
  expect(ws.sent).toContain('ls\r');

  sock.resize(120, 40);
  expect(ws.sent).toContain(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

  sock.close();
});
