import { wsUrl } from '../lib/basePath';
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
  /** Fired when a *reconnection* opens, before the server replays its buffer. The consumer
   *  marks what it shows as stale; the replay that follows replaces it (W2-I: the view is not
   *  emptied while the replay is on its way). */
  onReset?: () => void;
  /** Fired after the last event of a batched replay (`?batch=1`). An older daemon sends single
   *  frames and no end mark, so this never fires there. */
  onReplayEnd?: () => void;
  onClose?: () => void;
  wsFactory?: (url: string) => TerminalWS;
}

// Bounds initial replay to the last N ring events (see ws/structured.ts) instead of the
// full history — on a long thread that's the difference between an instant open and a
// ~10s one spent folding thousands of events into a non-virtualized list.
const REPLAY_TAIL = 200;

/** A socket that has not opened after this long is closed and tried again (a cellular link can
 *  swallow the handshake; the browser's own timeout is a minute or more). */
export const CONNECT_TIMEOUT_MS = 8000;

// `batch=1`: the daemon sends the replay as one compressed frame, `{ type: 'replay', events }` (W2-I).
// A daemon that does not know the parameter ignores it and sends the frames one by one.
function url(terminalId: string): string {
  return wsUrl(`/api/terminals/${terminalId}/structured-ws?tail=${REPLAY_TAIL}&batch=1`);
}

/** The live sockets of this page, so a resume can replace them without a remount of the views. */
const live = new Set<() => void>();

/** Replace every open or connecting structured socket with a new connection, now. Each view keeps
 *  its items (stale) until its replay arrives. Used after a resume whose liveness check failed. */
export function reconnectStructuredSockets(): void {
  for (const reconnect of [...live]) reconnect();
}

export function openStructuredSocket(opts: Opts) {
  const factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as TerminalWS);

  let ws: TerminalWS | null = null;
  let stopped = false;        // set by close() — a user-initiated teardown never reconnects
  let connectedOnce = false;  // distinguishes the first connect from a reconnect (for onReset)
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Drop the current socket without its close handler: the caller decides what happens next. */
  function detach() {
    clearTimeout(connectTimer);
    const old = ws;
    ws = null;
    if (!old) return;
    old.onopen = null; old.onclose = null; old.onmessage = null;
    try { old.close(); } catch { /* ignore */ }
  }

  function connect() {
    if (stopped) return;
    const sock = factory(url(opts.terminalId));
    ws = sock;
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (stopped || ws !== sock) return;
      // Still CONNECTING: give up on this attempt and start another one at once.
      detach();
      opts.onClose?.();
      connect();
    }, CONNECT_TIMEOUT_MS);
    sock.onopen = () => {
      clearTimeout(connectTimer);
      backoff = 500;
      // On a reconnect the server replays buffered events; tell the consumer first.
      if (connectedOnce) opts.onReset?.();
      connectedOnce = true;
    };
    sock.onmessage = (ev) => {
      let msg: unknown;
      try { msg = JSON.parse(ev.data); } catch { return; /* ignore malformed frames */ }
      const m = msg as { type?: unknown; events?: unknown; done?: unknown } | null;
      if (m && m.type === 'replay' && Array.isArray(m.events)) {
        // One task for the whole replay: React folds every event into one render.
        for (const e of m.events) { try { opts.onEvent(e); } catch { /* one bad event must not cost the rest */ } }
        if (m.done !== false) { try { opts.onReplayEnd?.(); } catch { /* ignore */ } }
        return;
      }
      try { opts.onEvent(msg); } catch { /* ignore */ }
    };
    sock.onclose = () => {
      clearTimeout(connectTimer);
      opts.onClose?.();
      if (stopped) return;
      // Reconnect with backoff so the pane self-heals after a dropped connection.
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
  }

  const reconnect = () => {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = undefined; }
    backoff = 500;
    detach();
    opts.onClose?.();
    connect();
  };
  live.add(reconnect);
  connect();

  return {
    close: () => {
      stopped = true;
      live.delete(reconnect);
      if (timer) clearTimeout(timer);
      clearTimeout(connectTimer);
      ws?.close();
    },
  };
}
