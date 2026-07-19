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
  /** Fired when a *reconnection* opens, before the server replays its buffer —
   *  the consumer should clear its view (e.g. xterm.reset()) so the replayed
   *  scrollback lands on a clean screen instead of duplicating. */
  onReset?: () => void;
  onClose?: () => void;
  wsFactory?: (url: string) => TerminalWS;
}

// Progressive scrollback (mobile): attach small, then step up on demand as the
// reader scrolls to the top. Desktop always passes MAX_REPLAY explicitly (or
// omits replayBytes, which defaults to the same value) so its replay is never
// trimmed and the rebuild path in TerminalTab never triggers there.
export const INITIAL_REPLAY_MOBILE = 256_000;
export const MAX_REPLAY = 4_000_000;

const REPLAY_STEPS = [INITIAL_REPLAY_MOBILE, 1_000_000, MAX_REPLAY];

/** Next replay size up from `current` (256K -> 1M -> 4M), saturating at MAX_REPLAY.
 *  Never returns a value smaller than `current`. */
export function nextReplayStep(current: number): number {
  for (const step of REPLAY_STEPS) {
    if (step > current) return step;
  }
  return Math.max(current, MAX_REPLAY);
}

function url(terminalId: string, replayBytes: number): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/terminals/${terminalId}/ws?replayBytes=${replayBytes}`;
}

export function openTerminalSocket(opts: Opts) {
  const replay = opts.replayBytes ?? MAX_REPLAY;
  const factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as TerminalWS);

  let ws: TerminalWS | null = null;
  let open = false;
  let stopped = false;        // set by close() — a user-initiated teardown never reconnects
  let connectedOnce = false;  // distinguishes the first connect from a reconnect (for onReset)
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Buffer sends until the socket is OPEN — otherwise resize/input thrown before
  // connect ("Still in CONNECTING state") are lost. The queue also survives a
  // reconnect so input typed during a blip is delivered once the pipe is back.
  const queue: string[] = [];
  const post = (data: string) => {
    if (open && ws) { try { ws.send(data); } catch { queue.push(data); } }
    else queue.push(data);
  };

  function connect() {
    if (stopped) return;
    const sock = factory(url(opts.terminalId, replay));
    ws = sock;
    sock.onopen = () => {
      open = true;
      backoff = 500;
      // On a reconnect the server replays the scrollback next; tell the consumer
      // to clear first so it isn't appended to the stale view.
      if (connectedOnce) opts.onReset?.();
      connectedOnce = true;
      while (queue.length) { try { sock.send(queue.shift()!); } catch { /* ignore */ } }
    };
    sock.onmessage = (ev) => opts.onData(ev.data);
    sock.onclose = () => {
      open = false;
      opts.onClose?.();
      if (stopped) return;
      // The server reaps idle/frozen sockets (e.g. a backgrounded PWA that
      // stopped answering pings). Reconnect with backoff so the pane self-heals.
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
  }

  connect();

  return {
    send: (input: string) => post(input),
    resize: (cols: number, rows: number) => post(JSON.stringify({ type: 'resize', cols, rows })),
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
