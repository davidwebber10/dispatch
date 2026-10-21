/**
 * The daemon's environment for a process it starts (a thread's PTY or structured CLI),
 * without the daemon's own PORT. A dev server that an agent starts reads PORT; with the
 * daemon's value it took Dispatch's port on 127.0.0.1 next to the daemon's wildcard bind,
 * and the browser then reached that server instead of Dispatch. Threads that need the
 * daemon's port read DISPATCH_PORT (sessions/service.ts).
 */
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out = { ...env } as Record<string, string>;
  delete out.PORT;
  return out;
}
