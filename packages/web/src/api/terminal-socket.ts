import { wsUrl } from '../lib/basePath';
export interface TerminalWS {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** The `dispatch:replay-meta` control frame (see the scrollback-offset contract).
 *  It describes WHERE in the PTY's lifetime output stream the replay that follows
 *  begins, which is the only way the client can tell whether a freshly replayed
 *  window is older, newer, or identical to what it already shows. */
export interface ReplayMeta {
  /** Absolute byte position, in the PTY's lifetime output, of the replay's first real byte. */
  startOffset: number;
  /** Total bytes the PTY has ever written (monotonic). */
  totalWritten: number;
  /** True when the replay reconstructs everything the PTY ever wrote. */
  complete: boolean;
}

const REPLAY_META_TYPE = 'dispatch:replay-meta';

interface Opts {
  terminalId: string;
  replayBytes?: number;
  onData: (chunk: string) => void;
  /** Supplying this opts INTO the meta protocol (adds `meta=1` to the URL). Without
   *  it the stream stays byte-for-byte what it has always been — no control frame —
   *  so an old client talking to a new daemon can never see JSON in its terminal. */
  onMeta?: (meta: ReplayMeta) => void;
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

function url(terminalId: string, replayBytes: number, meta: boolean): string {
  const base = wsUrl(`/api/terminals/${terminalId}/ws?replayBytes=${replayBytes}`);
  return meta ? `${base}&meta=1` : base;
}

/** Returns the parsed control frame, or null when the frame is ordinary terminal
 *  output. Deliberately conservative: anything that is not valid JSON carrying our
 *  exact `type` is data, because swallowing real PTY bytes is unrecoverable. */
function parseReplayMeta(data: unknown): ReplayMeta | null {
  if (typeof data !== 'string' || data.charCodeAt(0) !== 0x7b /* { */) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  if (m.type !== REPLAY_META_TYPE) return null;
  return {
    startOffset: typeof m.startOffset === 'number' ? m.startOffset : 0,
    totalWritten: typeof m.totalWritten === 'number' ? m.totalWritten : 0,
    complete: m.complete === true,
  };
}

export function openTerminalSocket(opts: Opts) {
  // Mutable, NOT captured once: every reconnect must re-read it. Capturing the
  // construction-time value meant a mobile reconnect re-requested the initial
  // 256KB even after the reader had paged back to 4MB — the terminal silently
  // collapsed to the last 256KB of history on every network blip.
  let replay = opts.replayBytes ?? MAX_REPLAY;
  const wantMeta = !!opts.onMeta;
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
    const sock = factory(url(opts.terminalId, replay, wantMeta));
    ws = sock;
    // The server sends the control frame first on EVERY connect that asked for it,
    // so the window is exactly one frame wide, per connection.
    let expectMeta = wantMeta;
    sock.onopen = () => {
      open = true;
      backoff = 500;
      // On a reconnect the server replays the scrollback next; tell the consumer
      // to clear first so it isn't appended to the stale view.
      if (connectedOnce) opts.onReset?.();
      connectedOnce = true;
      while (queue.length) { try { sock.send(queue.shift()!); } catch { /* ignore */ } }
    };
    sock.onmessage = (ev) => {
      if (expectMeta) {
        expectMeta = false;
        const meta = parseReplayMeta(ev.data);
        if (meta) { opts.onMeta?.(meta); return; }
      }
      opts.onData(ev.data);
    };
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
    /** Change the replay window used by FUTURE reconnects of this socket. Call it
     *  after the view has been rebuilt at a larger size so a later reconnect
     *  restores that size instead of shrinking the history back down. */
    setReplayBytes: (bytes: number) => { replay = bytes; },
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
