import { wsUrl } from '../lib/basePath';
import type { JournalFrame } from './types';
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
  /**
   * W3-D: the newest journal sequence the consumer holds, or undefined when its view is not exactly
   * the journal up to a sequence (a block still streams, or it has seen no sequence). Read at each
   * connect: a number goes out as `after=<seq>`, and the daemon then sends only what is newer.
   */
  resumeAfter?: () => number | undefined;
  /** W3-D: called with each event right before `onEvent` (replayed or live). The consumer reads the event's `seq` here. */
  onEventSeen?: (event: unknown) => void;
  /**
   * W3-D: the `journal` frame of a daemon that replays from its message journal. With this handler the
   * frame goes here and not to `onEvent`. Without it, each item is delivered to `onEvent` as its
   * event with the item's `seq`.
   */
  onJournal?: (frame: JournalFrame) => void;
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
// `journal=1`: the daemon replays from its message journal, as one `journal` frame of finished items (W3-D).
// `after=<seq>`: only the items after that sequence (a reconnect that kept its view).
// A daemon that does not know a parameter ignores it and sends the frames as it always did.
function url(terminalId: string, after?: number): string {
  const cursor = typeof after === 'number' && Number.isInteger(after) && after >= 0 ? `&after=${after}` : '';
  return wsUrl(`/api/terminals/${terminalId}/structured-ws?tail=${REPLAY_TAIL}&batch=1&journal=1${cursor}`);
}

function isJournalFrame(v: unknown): v is JournalFrame {
  const f = v as { type?: unknown; items?: unknown } | null;
  return !!f && f.type === 'journal' && Array.isArray(f.items);
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

  /** One event to the consumer. One bad event must not cost the rest. */
  function event(e: unknown) {
    try { opts.onEventSeen?.(e); } catch { /* ignore */ }
    try { opts.onEvent(e); } catch { /* ignore */ }
  }
  function deliver(e: unknown) {
    if (!isJournalFrame(e)) { event(e); return; }
    if (opts.onJournal) { try { opts.onJournal(e); } catch { /* ignore */ } return; }
    for (const item of e.items) {
      const payload = item?.payload;
      if (payload && typeof payload === 'object') event({ ...(payload as object), seq: item.seq });
    }
  }

  function connect() {
    if (stopped) return;
    let after: number | undefined;
    try { after = opts.resumeAfter?.(); } catch { after = undefined; } // no cursor: the daemon sends the newest window
    const sock = factory(url(opts.terminalId, after));
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
        for (const e of m.events) deliver(e);
        if (m.done !== false) { try { opts.onReplayEnd?.(); } catch { /* ignore */ } }
        return;
      }
      deliver(msg);
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
