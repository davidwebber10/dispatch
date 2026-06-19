export type ServerEvent = { type: string; [k: string]: unknown };

export interface WebSocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close(): void;
}

interface Opts {
  onEvent: (e: ServerEvent) => void;
  onStatus: (s: 'connecting' | 'open' | 'closed') => void;
  wsFactory?: (url: string) => WebSocketLike;
}

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/events`;
}

export function createEventsSocket(opts: Opts): { close(): void } {
  const factory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  let ws: WebSocketLike | null = null;
  let stopped = false;
  let backoff = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function connect() {
    if (stopped) return;
    opts.onStatus('connecting');
    ws = factory(defaultUrl());
    ws.onopen = () => { backoff = 500; opts.onStatus('open'); };
    ws.onmessage = (ev) => {
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
  };
}
