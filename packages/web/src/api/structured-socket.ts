export interface TerminalWS {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

interface Opts {
  terminalId: string;
  onEvent: (event: unknown) => void;
  /** Fired when a *reconnection* opens, before the server replays its buffer —
   *  the consumer should clear its view so the replayed events land on a clean
   *  slate instead of duplicating. */
  onReset?: () => void;
  onClose?: () => void;
  wsFactory?: (url: string) => TerminalWS;
}

// Bounds initial replay to the last N ring events (see ws/structured.ts) instead of the
// full history — on a long thread that's the difference between an instant open and a
// ~10s one spent folding thousands of events into a non-virtualized list.
const REPLAY_TAIL = 200;

function url(terminalId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/terminals/${terminalId}/structured-ws?tail=${REPLAY_TAIL}`;
}

export function openStructuredSocket(opts: Opts) {
  const factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as TerminalWS);

  let ws: TerminalWS | null = null;
  let stopped = false;        // set by close() — a user-initiated teardown never reconnects
  let connectedOnce = false;  // distinguishes the first connect from a reconnect (for onReset)
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    if (stopped) return;
    const sock = factory(url(opts.terminalId));
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      // On a reconnect the server replays buffered events; tell the consumer
      // to clear first so it isn't appended to the stale view.
      if (connectedOnce) opts.onReset?.();
      connectedOnce = true;
    };
    sock.onmessage = (ev) => {
      try { opts.onEvent(JSON.parse(ev.data)); } catch { /* ignore malformed frames */ }
    };
    sock.onclose = () => {
      opts.onClose?.();
      if (stopped) return;
      // Reconnect with backoff so the pane self-heals after a dropped connection.
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
  }

  connect();

  return {
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
