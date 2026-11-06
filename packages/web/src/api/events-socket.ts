import { wsUrl } from '../lib/basePath';
export type ServerEvent = { type: string; [k: string]: unknown };

export interface WebSocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close(): void;
  send?(data: string): void;
  readyState?: number;
}

/** The daemon's answer to the liveness check (core ws/events.ts). Mirrors EVENTS_PONG. */
const PONG = '{"type":"pong"}';

interface Opts {
  onEvent: (e: ServerEvent) => void;
  onStatus: (s: 'connecting' | 'open' | 'closed') => void;
  wsFactory?: (url: string) => WebSocketLike;
}

function defaultUrl(): string {
  return wsUrl('/api/events');
}

export interface EventsSocket {
  close(): void;
  reconnect(): void;
  /**
   * Is the connection really alive? Sends a ping and waits up to `timeoutMs` for the daemon's
   * pong. False when the socket is not open or no answer comes (iOS can kill a socket in the
   * background without telling the page). An older daemon never answers, so it reads as dead
   * and the caller falls back to a full reconnect, as before.
   */
  checkAlive(timeoutMs: number): Promise<boolean>;
}

export function createEventsSocket(opts: Opts): EventsSocket {
  const factory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  let ws: WebSocketLike | null = null;
  let stopped = false;
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pongWaiters: Array<() => void> = [];

  function connect() {
    if (stopped) return;
    opts.onStatus('connecting');
    ws = factory(defaultUrl());
    ws.onopen = () => { backoff = 500; opts.onStatus('open'); };
    ws.onmessage = (ev) => {
      if (ev.data === PONG) { const w = pongWaiters; pongWaiters = []; w.forEach((f) => f()); return; }
      try { opts.onEvent(JSON.parse(ev.data) as ServerEvent); } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      opts.onStatus('closed');
      if (stopped) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
  }

  connect();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
    checkAlive(timeoutMs) {
      const sock = ws;
      if (stopped || !sock?.send || (sock.readyState !== undefined && sock.readyState !== 1)) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(t); pongWaiters = pongWaiters.filter((f) => f !== onPong); resolve(v); };
        const onPong = () => finish(sock === ws);
        const t = setTimeout(() => finish(false), timeoutMs);
        pongWaiters.push(onPong);
        try { sock.send!('ping'); } catch { finish(false); }
      });
    },
    // Force an immediate fresh connection — used when the app returns from the
    // background. iOS silently kills sockets without always firing onclose, so
    // the status can read "open" over a dead pipe. We null the old onclose so
    // its backoff timer doesn't race a second connect(), and report 'closed' ourselves.
    reconnect() {
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = undefined; }
      backoff = 500;
      if (ws) {
        ws.onclose = null; try { ws.close(); } catch { /* ignore */ }
        // The detached onclose will never report this loss. Report it here so a closed -> open
        // pair still reaches the app, which resyncs events missed while the pipe was dead
        // (a CLI/Pretty switch made on another device was never applied on this phone).
        opts.onStatus('closed');
      }
      connect();
    },
  };
}
