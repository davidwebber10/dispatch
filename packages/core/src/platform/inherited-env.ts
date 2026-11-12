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

/** The box secrets (platform/box-secrets.ts). No process the daemon starts ever gets one, whatever layer names it. */
export const BOX_SECRET_NAMES = ['DISPATCH_BOX_TOKEN', 'OS_BOX_TOKEN'] as const;

/**
 * THE environment of a process the daemon starts for a thread, a shell, a plugin worker or a hook:
 * the daemon's own (`inheritedEnv`), then each layer in order (the spawn env of the build, the thread's
 * own additions), then the box secrets removed again, so that no layer can bring one back. The thread
 * managers, the PTY manager and the plugin runners all build their env here and nowhere else.
 *
 * PRIVILEGE SEPARATION HOOKS IN HERE AND AT ITS CALLERS: when the agents' processes run under another
 * operating-system user, the uid/gid of the child is decided next to this call (the `spawn` options of
 * structured/manager.ts, structured/shared/jsonrpc-client.ts, structured/acp-manager.ts, pty/manager.ts),
 * and HOME and the harness config folders of that user are set in the layers given here.
 */
export function childEnv(...layers: Array<Record<string, string | undefined> | NodeJS.ProcessEnv | undefined>): Record<string, string> {
  const out: Record<string, string> = inheritedEnv();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) out[k] = v;
  }
  for (const name of BOX_SECRET_NAMES) delete out[name];
  return out;
}
