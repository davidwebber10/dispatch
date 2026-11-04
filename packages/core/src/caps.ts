/**
 * Size and count caps (SEC-23). Each one has a default that normal use never reaches and an environment
 * variable to change it. They are read at the moment of use, so a test (or a restart with a new value) sees the change.
 * A value that is not a number, or is negative, falls back to the default; 0 turns off the caps that say so.
 */
function fromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MiB = 1024 * 1024;

/** A JSON request body, on every route that does not need more. DISPATCH_MAX_JSON_BYTES (default 1 MiB). */
export const maxJsonBytes = (): number => fromEnv('DISPATCH_MAX_JSON_BYTES', 1 * MiB) || 1 * MiB;

/**
 * A JSON request body on the few routes that carry big payloads (the agent hook events with whole file reads,
 * a message with attached images, the file editor's save, the icon upload). Default 50 MiB, the old limit for every route.
 */
export const maxLargeJsonBytes = (): number => fromEnv('DISPATCH_MAX_LARGE_JSON_BYTES', 50 * MiB) || 50 * MiB;

/** One WebSocket message from a client (the terminal socket carries typed and pasted input). DISPATCH_WS_MAX_PAYLOAD (default 1 MiB). */
export const wsMaxPayload = (): number => fromEnv('DISPATCH_WS_MAX_PAYLOAD', 1 * MiB) || 1 * MiB;

/** One message on the terminal socket, which carries typed and pasted input (a whole paste is one message). DISPATCH_WS_TERMINAL_MAX_PAYLOAD (default 8 MiB). */
export const wsTerminalMaxPayload = (): number => fromEnv('DISPATCH_WS_TERMINAL_MAX_PAYLOAD', 8 * MiB) || 8 * MiB;

/** Running threads (a live process) in one project before a new one is refused. DISPATCH_MAX_LIVE_THREADS (default 60; 0 = no cap). */
export const maxLiveThreadsPerProject = (): number => fromEnv('DISPATCH_MAX_LIVE_THREADS', 60);

/** The shortest gap between two runs of a recurring schedule. DISPATCH_MIN_SCHEDULE_MINUTES (default 1; 0 = no minimum). */
export const minScheduleMinutes = (): number => fromEnv('DISPATCH_MIN_SCHEDULE_MINUTES', 1);

/**
 * Push subscriptions (one per browser or phone) stored before a new device is refused. A person has a handful of
 * devices; the cap only stops a runaway client or a hostile caller from filling the table, and the Settings list lets
 * the owner remove old ones. DISPATCH_MAX_PUSH_SUBSCRIPTIONS (default 50; 0 = no cap).
 */
export const maxPushSubscriptions = (): number => fromEnv('DISPATCH_MAX_PUSH_SUBSCRIPTIONS', 50);

/**
 * Live watches in the whole daemon, over all watchers. The per-watcher limit (20) stays; this stops many watchers
 * together from growing the table without bound. DISPATCH_MAX_WATCHES (default 500; 0 = no cap).
 */
export const maxWatchesTotal = (): number => fromEnv('DISPATCH_MAX_WATCHES', 500);

/**
 * One line of an agent run's JSON output, held in memory until its newline. A line is one event, and an event can
 * carry a whole file read, so the default is large. A longer line is dropped (with a log line) and the parser resumes
 * at the next newline. DISPATCH_MAX_STREAM_LINE_BYTES (default 32 MiB; 0 = no cap).
 */
export const maxStreamLineBytes = (): number => fromEnv('DISPATCH_MAX_STREAM_LINE_BYTES', 32 * MiB);

/**
 * Data a WebSocket client has not yet read, before the daemon drops that client. A slow or stalled browser would
 * otherwise make the daemon hold every terminal and event byte for it. The browser reconnects and replays. The
 * default is far above what a working connection holds. DISPATCH_WS_MAX_BUFFERED_BYTES (default 32 MiB; 0 = no cap).
 */
export const wsMaxBufferedBytes = (): number => fromEnv('DISPATCH_WS_MAX_BUFFERED_BYTES', 32 * MiB);

/**
 * Uncaught errors in one minute before the daemon exits so its supervisor restarts it clean. Below this it logs and
 * keeps running, so one stray error does not kill every live agent thread. DISPATCH_MAX_UNCAUGHT_PER_MINUTE
 * (default 10; 0 = never exit).
 */
export const maxUncaughtPerMinute = (): number => fromEnv('DISPATCH_MAX_UNCAUGHT_PER_MINUTE', 10);
