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
  // A thread key or a box token that reached the daemon's own environment must never ride into a
  // thread, a probe or a tool that the daemon starts (per-thread keys, spec 6.3).
  for (const name of ['DISPATCH_BOX_TOKEN', 'OS_BOX_TOKEN', 'DISPATCH_AUTH', 'DISPATCH_AUTH_FILE']) delete out[name];
  return out;
}
