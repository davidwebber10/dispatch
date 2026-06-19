export interface TerminalWS {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

interface Opts {
  terminalId: string;
  replayBytes?: number;
  onData: (chunk: string) => void;
  onClose?: () => void;
  wsFactory?: (url: string) => TerminalWS;
}

function url(terminalId: string, replayBytes: number): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/terminals/${terminalId}/ws?replayBytes=${replayBytes}`;
}

export function openTerminalSocket(opts: Opts) {
  const replay = opts.replayBytes ?? 1_000_000;
  const factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as TerminalWS);
  const ws = factory(url(opts.terminalId, replay));

  // Buffer sends until the socket is OPEN — otherwise resize/input thrown before
  // connect ("Still in CONNECTING state") are lost.
  let open = false;
  const queue: string[] = [];
  const post = (data: string) => {
    if (open) { try { ws.send(data); } catch { queue.push(data); } }
    else queue.push(data);
  };

  ws.onopen = () => { open = true; while (queue.length) { try { ws.send(queue.shift()!); } catch { /* ignore */ } } };
  ws.onmessage = (ev) => opts.onData(ev.data);
  ws.onclose = () => { open = false; opts.onClose?.(); };

  return {
    send: (input: string) => post(input),
    resize: (cols: number, rows: number) => post(JSON.stringify({ type: 'resize', cols, rows })),
    close: () => ws.close(),
  };
}
